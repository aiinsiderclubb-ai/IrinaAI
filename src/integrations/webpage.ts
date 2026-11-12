/**
 * Opens a web page for the assistant (e.g. a manufacturer's site: what they make, capabilities, contacts)
 * and turns it into compact, readable text for the LLM. No dependencies: Node's fetch + a small
 * tolerant HTML parser.
 *
 * Safety: only http/https, and by default every hop (including redirects) must resolve to public
 * addresses only, so the bot cannot be used to poke at Render's internal network or cloud metadata.
 */
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { Readable, pipeline } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';

export interface PageLink {
  text: string;
  url: string;
}

export interface WebPage {
  /** requested (normalized: scheme added, fragment dropped) */
  url: string;
  /** after redirects */
  finalUrl: string;
  title: string;
  /** meta description / og:description */
  description?: string;
  lang?: string;
  /** readable text with light Markdown: '## ' for h1-h3, '- ' list items, table rows '| a | b |', paragraphs separated by blank lines */
  text: string;
  /** emails, phones (tel: links + plausible international numbers in text), messengers (wa.me, t.me, viber links) */
  contacts: { emails: string[]; phones: string[]; messengers: string[] };
  /** same-site links that look useful for research (contacts, about, products, production, prices...), max 15 */
  keyLinks: PageLink[];
  /** non-HTML responses: content-type and raw bytes, so the caller can run its own PDF/DOCX extractor */
  binary?: { contentType: string; data: Uint8Array; filename: string };
  truncated?: boolean;
}

export interface OpenPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  /** disables the SSRF guard (tests against a local server) */
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
}

export type WebPageErrorCode = 'bad_url' | 'blocked' | 'dns' | 'network' | 'timeout' | 'http' | 'redirects' | 'unsupported';

/** The message is user-facing (Ukrainian); `code`/`status` are for the caller's logic. */
export class WebPageError extends Error {
  override name = 'WebPageError';
  constructor(
    message: string,
    readonly code: WebPageErrorCode = 'network',
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_CONTACTS = 10;
const MAX_KEY_LINKS = 15;

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk,en;q=0.8,ru;q=0.6',
};

// ───────────────────────────── opening a page ─────────────────────────────

interface FetchCtx {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
  allowPrivate: boolean;
  hops: number;
  /** cookies set during this one call (language/geo redirects loop forever without them); never persisted */
  cookies: Map<string, StoredCookie>;
  /** intermediate certificates fetched for sites that do not send their full chain */
  extraCa: string[];
  chainRepairTried: boolean;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
}

export async function openPage(url: string, opts: OpenPageOptions = {}): Promise<WebPage> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const { url: requested, guessedScheme } = normalizeUrl(url);
  const ctx: FetchCtx = {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
    allowPrivate: opts.allowPrivate === true,
    hops: 0,
    cookies: new Map(),
    extraCa: [],
    chainRepairTried: false,
  };

  let fetched: Fetched;
  try {
    fetched = await fetchFollowingRedirects(requested, ctx);
  } catch (e) {
    // "site.ua" typed without a scheme: plenty of small sites still have no working https
    if (!(guessedScheme && e instanceof WebPageError && e.code === 'network' && !ctx.signal.aborted)) throw e;
    const plain = new URL(requested.href);
    plain.protocol = 'http:';
    ctx.hops = 0;
    fetched = await fetchFollowingRedirects(plain, ctx);
  }

  for (let refreshes = 0; ; refreshes++) {
    const { page, refresh } = await readResponse(fetched, requested, ctx, maxBytes, maxChars);
    // a near-empty page that only says <meta http-equiv="refresh" content="0; url=/uk/">
    if (refresh && refreshes < 2 && ctx.hops < MAX_REDIRECTS && page.text.length < 500) {
      ctx.hops++;
      fetched = await fetchFollowingRedirects(refresh, ctx);
      continue;
    }
    return page;
  }
}

function normalizeUrl(raw: string): { url: URL; guessedScheme: boolean } {
  let s = raw.trim();
  if (!s) throw new WebPageError('Порожня адреса сторінки', 'bad_url');
  let guessedScheme = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // explicit scheme
  } else if (s.startsWith('//')) {
    s = `https:${s}`;
    guessedScheme = true;
  } else if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) {
    // "example.com/page" or "localhost:3000" (host:port is not a scheme); "mailto:x" falls through and is rejected below
    s = `https://${s}`;
    guessedScheme = true;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new WebPageError(`Некоректна адреса сторінки: ${raw.trim().slice(0, 200)}`, 'bad_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebPageError(`Відкриваю лише http/https-сторінки, а це «${url.protocol.slice(0, -1)}»`, 'bad_url');
  }
  if (!url.hostname) throw new WebPageError('В адресі немає сайту', 'bad_url');
  url.hash = '';
  url.username = '';
  url.password = '';
  return { url, guessedScheme };
}

interface Fetched {
  res: Response;
  url: URL;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchFollowingRedirects(start: URL, ctx: FetchCtx): Promise<Fetched> {
  let current = start;
  for (;;) {
    await guardHost(current, ctx);
    const res = await send(current, ctx);
    storeCookies(ctx.cookies, res, current);
    if (!REDIRECT_STATUSES.has(res.status)) return { res, url: current };

    const location = res.headers.get('location');
    discard(res);
    if (!location) throw new WebPageError(`Сайт повернув переадресацію без адреси (HTTP ${res.status})`, 'http', res.status);
    if (++ctx.hops > MAX_REDIRECTS) throw new WebPageError(`Забагато переадресацій (більше ${MAX_REDIRECTS})`, 'redirects');
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new WebPageError('Сайт переадресовує на некоректну адресу', 'bad_url');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new WebPageError(`Сайт переадресовує на «${next.protocol.slice(0, -1)}»-адресу — таке не відкриваю`, 'bad_url');
    }
    next.hash = '';
    next.username = '';
    next.password = '';
    current = next;
  }
}

/** One request, no redirect following. */
async function send(url: URL, ctx: FetchCtx): Promise<Response> {
  const cookie = cookieHeader(ctx.cookies, url);
  const headers = cookie ? { ...REQUEST_HEADERS, Cookie: cookie } : REQUEST_HEADERS;
  const viaExtraCa = ctx.extraCa.length > 0 && url.protocol === 'https:';
  try {
    if (viaExtraCa) return await requestWithCa(url, headers, ctx.extraCa, ctx.signal);
    return await ctx.fetchImpl(url.href, { method: 'GET', headers, redirect: 'manual', signal: ctx.signal });
  } catch (e) {
    const code = errorCode(e);
    if (!viaExtraCa && !ctx.chainRepairTried && url.protocol === 'https:' && code && CHAIN_ERRORS.has(code) && !ctx.signal.aborted) {
      ctx.chainRepairTried = true;
      const pem = await issuerCertificate(url, ctx).catch(() => undefined);
      if (pem) {
        ctx.extraCa.push(pem);
        return send(url, ctx);
      }
    }
    throw networkError(e, ctx);
  }
}

// Plenty of sites (obolon.ua, antonov.com) send only their own certificate, without the intermediate.
// Browsers quietly download the missing one from the certificate's AIA "CA Issuers" URL; Node does not.
// We do the same, then retry over node:https with that intermediate added to the normal root store, so
// the chain is still fully verified.
const CHAIN_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

async function issuerCertificate(url: URL, ctx: FetchCtx): Promise<string | undefined> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const leaf = await raceSignal(
    new Promise<tls.PeerCertificate>((resolve, reject) => {
      // only reads the certificate; nothing is sent over this connection
      const socket = tls.connect(
        { host, port: Number(url.port) || 443, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false },
        () => {
          resolve(socket.getPeerCertificate());
          socket.destroy();
        },
      );
      socket.once('error', reject);
      socket.setTimeout(ctx.timeoutMs, () => socket.destroy(new Error('timeout')));
      ctx.signal.addEventListener('abort', () => socket.destroy(), { once: true });
    }),
    ctx.signal,
  );
  const uri = leaf.infoAccess?.['CA Issuers - URI']?.[0];
  if (!uri) return undefined;
  const aia = new URL(uri);
  if (aia.protocol !== 'http:' && aia.protocol !== 'https:') return undefined;
  await guardHost(aia, ctx);
  const res = await ctx.fetchImpl(aia.href, { redirect: 'manual', signal: ctx.signal });
  if (!res.ok) {
    discard(res);
    return undefined;
  }
  const { data, truncated } = await readBody(res, 64 * 1024, ctx);
  if (truncated) return undefined;
  const issuer = new X509Certificate(data); // DER or PEM; a PKCS#7 bundle throws and we give up
  return issuer.toString();
}

/** A fetch-shaped GET over node:https with extra trusted intermediates. */
function requestWithCa(url: URL, headers: Record<string, string>, extraCa: string[], signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
        ca: [...tls.rootCertificates, ...extraCa],
        signal,
      },
      (res) => {
        const out = new Headers();
        for (let k = 0; k + 1 < res.rawHeaders.length; k += 2) {
          try {
            out.append(res.rawHeaders[k]!, res.rawHeaders[k + 1]!);
          } catch {
            /* a header value fetch would not accept either */
          }
        }
        const status = res.statusCode ?? 502;
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const decoder =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? zlib.createGunzip()
            : encoding === 'deflate'
              ? zlib.createInflate()
              : encoding === 'br'
                ? zlib.createBrotliDecompress()
                : undefined;
        const stream: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
        const body = status === 204 || status === 304 ? null : Readable.toWeb(stream);
        try {
          resolve(new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: out }));
        } catch (e) {
          res.destroy();
          reject(e);
        }
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A minimal cookie jar: name=value by domain, path/secure ignored, lives for one openPage call. */
function storeCookies(jar: Map<string, StoredCookie>, res: Response, url: URL): void {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const host = url.hostname.toLowerCase();
  for (const line of lines) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = host;
    let hostOnly = true;
    let expired = false;
    let foreign = false;
    for (const attr of attrs) {
      const at = attr.indexOf('=');
      const key = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase();
      const v = at === -1 ? '' : attr.slice(at + 1).trim();
      if (key === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (host === d || host.endsWith(`.${d}`)) {
          domain = d;
          hostOnly = false;
        } else foreign = true;
      } else if (key === 'max-age' && Number(v) <= 0) expired = true;
      else if (key === 'expires' && Date.parse(v) < Date.now()) expired = true;
    }
    if (foreign) continue;
    const id = `${domain}\t${name}`;
    if (expired) jar.delete(id);
    else if (jar.has(id) || jar.size < 50) jar.set(id, { name, value, domain, hostOnly });
  }
}

function cookieHeader(jar: Map<string, StoredCookie>, url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const parts: string[] = [];
  for (const c of jar.values()) {
    if (c.hostOnly ? c.domain === host : host === c.domain || host.endsWith(`.${c.domain}`)) parts.push(`${c.name}=${c.value}`);
  }
  return parts.length ? parts.join('; ') : undefined;
}

/** SSRF guard, re-run for every hop. */
async function guardHost(url: URL, ctx: FetchCtx): Promise<void> {
  if (ctx.allowPrivate) return;
  let ok: boolean;
  try {
    ok = await raceSignal(isPublicHost(url.hostname), ctx.signal);
  } catch (e) {
    if (ctx.signal.aborted) throw timeoutError(ctx.timeoutMs);
    if (e instanceof WebPageError) throw e;
    throw new WebPageError(`Не вдалося знайти сайт ${url.hostname} — перевір адресу`, 'dns');
  }
  if (!ok) throw new WebPageError('Це внутрішня адреса — її не відкриваю', 'blocked');
}

function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

function timeoutError(ms: number): WebPageError {
  const s = ms >= 1000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10).replace('.', ',');
  return new WebPageError(`Сайт не відповів за ${s} с`, 'timeout');
}

function errorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function networkError(e: unknown, ctx: FetchCtx): WebPageError {
  if (e instanceof WebPageError) return e;
  if (ctx.signal.aborted) return timeoutError(ctx.timeoutMs);
  const code = errorCode(e);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') {
    return new WebPageError('Не вдалося знайти сайт — перевір адресу', 'dns');
  }
  if (code === 'ECONNREFUSED') return new WebPageError('Сайт відхилив з’єднання', 'network');
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new WebPageError('Сайт обірвав з’єднання', 'network');
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new WebPageError('Сайт не відповідає', 'timeout');
  }
  if (code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)|SIGNATURE/i.test(code)) {
    return new WebPageError('Проблема з SSL-сертифікатом сайту', 'network');
  }
  return new WebPageError(`Не вдалося відкрити сайт${code ? ` (${code})` : ''}`, 'network');
}

function httpError(status: number): WebPageError {
  let hint = '';
  if (status === 401 || status === 403) hint = ' — сайт не пускає автоматичні запити або потрібен вхід';
  else if (status === 429) hint = ' — забагато запитів, спробуй пізніше';
  else if (status >= 500) hint = ' — проблема на боці сайту';
  return new WebPageError(`Сторінка недоступна (HTTP ${status})${hint}`, 'http', status);
}

// ───────────────────────────── body & content types ─────────────────────────────

interface Body {
  data: Uint8Array;
  truncated: boolean;
  timedOut: boolean;
}

/** Streams the body and stops at the byte cap; a timeout mid-body keeps what already arrived. */
async function readBody(res: Response, maxBytes: number, ctx: FetchCtx): Promise<Body> {
  if (!res.body) return { data: new Uint8Array(0), truncated: false, timedOut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let timedOut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    if (!ctx.signal.aborted) throw networkError(e, ctx);
    timedOut = true;
  }
  if (truncated || timedOut) reader.cancel().catch(() => {});
  const data = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return { data, truncated, timedOut };
}

const DOC_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
};

const GENERIC_BINARY = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
  'application/force-download',
  'application/download',
  'application/unknown',
]);

type Kind = 'html' | 'text' | 'binary' | 'sniff' | 'unsupported';

function isDocMime(m: string): boolean {
  return (
    m === 'application/pdf' ||
    m === 'application/x-pdf' ||
    m === 'application/msword' ||
    m === 'application/rtf' ||
    m === 'text/rtf' ||
    m.startsWith('application/vnd.openxmlformats-officedocument.') ||
    m.startsWith('application/vnd.ms-') ||
    m.startsWith('application/vnd.oasis.opendocument.')
  );
}

function kindOf(mime: string, ext: string): Kind {
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'application/vnd.wap.xhtml+xml') return 'html';
  if (isDocMime(mime)) return 'binary';
  if (mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json') || mime === 'application/xml' || mime.endsWith('+xml')) {
    return 'text';
  }
  if (GENERIC_BINARY.has(mime)) return 'sniff';
  if (DOC_TYPES[ext]) return 'binary'; // e.g. .docx served as application/zip
  return 'unsupported';
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

function dispositionFilename(cd: string): string | undefined {
  const star = /filename\*\s*=\s*(?:[\w-]+'[^']*')?([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
  const v = (plain?.[1] ?? plain?.[2])?.trim();
  return v || undefined;
}

function fileNameFor(url: URL, disposition: string, contentType: string): string {
  let name = dispositionFilename(disposition) ?? '';
  if (!name) {
    const seg = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      name = decodeURIComponent(seg);
    } catch {
      name = seg;
    }
  }
  name = name.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || 'document';
  if (!extOf(name)) {
    const ext = Object.keys(DOC_TYPES).find((k) => DOC_TYPES[k] === contentType);
    if (ext) name += `.${ext}`;
  }
  return name;
}

function startsWithBytes(data: Uint8Array, sig: number[]): boolean {
  return sig.every((b, k) => data[k] === b);
}

async function readResponse(
  { res, url: finalUrl }: Fetched,
  requested: URL,
  ctx: FetchCtx,
  maxBytes: number,
  maxChars: number,
): Promise<{ page: WebPage; refresh?: URL }> {
  if (res.status < 200 || res.status >= 300) {
    discard(res);
    throw httpError(res.status);
  }
  const ctRaw = res.headers.get('content-type') ?? '';
  const mime = (ctRaw.split(';')[0] ?? '').trim().toLowerCase();
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(ctRaw)?.[1];
  const disposition = res.headers.get('content-disposition') ?? '';
  const ext = extOf(finalUrl.pathname) || extOf(dispositionFilename(disposition) ?? '');

  if (/^(image|video)\//.test(mime)) {
    discard(res);
    throw new WebPageError('Це зображення/відео, а не сторінка', 'unsupported');
  }
  if (mime.startsWith('audio/')) {
    discard(res);
    throw new WebPageError('Це аудіо, а не сторінка', 'unsupported');
  }
  let kind = kindOf(mime, ext);
  if (kind === 'unsupported') {
    discard(res);
    throw new WebPageError(`Це файл (${mime}), а не сторінка — прочитати його не можу`, 'unsupported');
  }

  const body = await readBody(res, maxBytes, ctx);
  const { data } = body;
  let contentType = mime === 'application/x-pdf' ? 'application/pdf' : mime;
  if (kind === 'sniff') {
    if (startsWithBytes(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      kind = 'binary';
      contentType = 'application/pdf';
    } else if (DOC_TYPES[ext]) {
      kind = 'binary';
      contentType = DOC_TYPES[ext]!;
    } else if (data.subarray(0, 1024).includes(0)) {
      throw new WebPageError(`Це файл (${mime || 'невідомий тип'}), а не сторінка — прочитати його не можу`, 'unsupported');
    } else {
      const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
      kind = /<(?:!doctype\s+html|html|head|body)\b/i.test(head) ? 'html' : 'text';
    }
  } else if (kind === 'binary' && !isDocMime(mime)) {
    contentType = DOC_TYPES[ext] ?? contentType;
  }

  if (body.timedOut && (kind === 'binary' || data.length === 0)) throw timeoutError(ctx.timeoutMs);
  let truncated = body.truncated || body.timedOut;

  const base = { url: requested.href, finalUrl: finalUrl.href };
  if (kind === 'binary') {
    const filename = fileNameFor(finalUrl, disposition, contentType);
    const page: WebPage = {
      ...base,
      title: filename,
      text: '',
      contacts: { emails: [], phones: [], messengers: [] },
      keyLinks: [],
      binary: { contentType, data, filename },
    };
    if (truncated) page.truncated = true;
    return { page };
  }

  const decoded = decodeText(data, charset, kind === 'html');
  if (kind === 'text') {
    let text = decoded.replace(/\r\n?/g, '\n').trim();
    if (text.length > maxChars) {
      text = clip(text, maxChars);
      truncated = true;
    }
    const page: WebPage = { ...base, title: '', text, contacts: extractContacts([text]), keyLinks: [] };
    if (truncated) page.truncated = true;
    return { page };
  }

  const parsed = parseHtml(decoded, finalUrl.href);
  let text = parsed.text;
  if (text.length > maxChars) {
    text = clip(text, maxChars);
    truncated = true;
  }
  const page: WebPage = {
    ...base,
    title: parsed.title,
    text,
    contacts: parsed.contacts,
    keyLinks: pickKeyLinks(parsed.links, finalUrl),
  };
  if (parsed.description) page.description = parsed.description;
  if (parsed.lang) page.lang = parsed.lang;
  if (truncated) page.truncated = true;

  let refresh: URL | undefined;
  if (parsed.refresh) {
    try {
      const target = new URL(parsed.refresh, finalUrl);
      target.hash = '';
      if ((target.protocol === 'http:' || target.protocol === 'https:') && target.href !== finalUrl.href) refresh = target;
    } catch {
      /* ignore a broken refresh target */
    }
  }
  return refresh ? { page, refresh } : { page };
}

/** Cuts at a line break near the limit when there is one. */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.8 ? cut.slice(0, nl) : cut).trimEnd();
}

// ───────────────────────────── charset ─────────────────────────────

function normalizeCharset(label: string | undefined): string | undefined {
  if (!label) return undefined;
  let l = label.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (/^(win|cp|windows)[-_]?1251$/.test(l)) l = 'windows-1251';
  else if (l === 'utf8') l = 'utf-8';
  try {
    return new TextDecoder(l).encoding;
  } catch {
    return undefined;
  }
}

function sniffMetaCharset(data: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(data.subarray(0, 4096));
  return /<meta[^>]*?charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i.exec(head)?.[1];
}

function isValidUtf8(data: Uint8Array): boolean {
  try {
    // stream: an incomplete sequence at the very end (byte cap) is not an error
    new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Bytes 0x80+ of a windows-1251 page are overwhelmingly Cyrillic letters (0xC0-0xFF, plus Ukrainian ІЇЄҐ). */
function looksLikeCp1251(data: Uint8Array): boolean {
  let high = 0;
  let letters = 0;
  for (const b of data.subarray(0, 65536)) {
    if (b < 0x80) continue;
    high++;
    if (b >= 0xc0 || [0xa5, 0xa8, 0xaa, 0xaf, 0xb2, 0xb3, 0xb4, 0xb8, 0xba, 0xbf].includes(b)) letters++;
  }
  return high > 0 && letters / high > 0.6;
}

const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

function decodeWith(label: string, data: Uint8Array): string {
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    if (label === 'windows-1251') {
      // Node built without full ICU
      let s = '';
      for (const b of data) s += b < 0x80 ? String.fromCharCode(b) : CP1251_HIGH[b - 0x80]!;
      return s;
    }
    return new TextDecoder('utf-8').decode(data);
  }
}

function decodeText(data: Uint8Array, headerCharset: string | undefined, isHtml: boolean): string {
  if (startsWithBytes(data, [0xef, 0xbb, 0xbf])) return decodeWith('utf-8', data.subarray(3));
  if (startsWithBytes(data, [0xff, 0xfe])) return decodeWith('utf-16le', data.subarray(2));
  if (startsWithBytes(data, [0xfe, 0xff])) return decodeWith('utf-16be', data.subarray(2));
  let cs = normalizeCharset(headerCharset);
  if (!cs && isHtml) cs = normalizeCharset(sniffMetaCharset(data));
  if (cs && cs !== 'utf-8') return decodeWith(cs, data);
  // declared or default utf-8: old Ukrainian sites often lie about it or say nothing at all
  if (!isValidUtf8(data) && looksLikeCp1251(data)) return decodeWith('windows-1251', data);
  return decodeWith('utf-8', data);
}

// ───────────────────────────── SSRF guard ─────────────────────────────

function ipv4Public(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function parseIpv6(input: string): number[] | undefined {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.', lastColon)) {
    const v4 = s.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return undefined;
    const [a, b, c, d] = v4 as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined): number[] =>
    part ? part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : [];
  const head = parse(halves[0]);
  let groups: number[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = parse(halves[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  if (groups.length !== 8 || groups.some(Number.isNaN)) return undefined;
  return groups;
}

function ipv6Public(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    if (g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return false; // :: and ::1
    // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d
    if ((g4 === 0 && (g5 === 0xffff || g5 === 0)) || (g4 === 0xffff && g5 === 0)) return ipv4Public(embedded(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b) return ipv4Public(embedded(g6, g7)); // NAT64
  if (g0 === 0x2002) return ipv4Public(embedded(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && (g1 === 0x0db8 || g1 === 0)) return false; // documentation, Teredo
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard-only
  return true;
}

function ipPublic(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Public(ip);
  if (v === 6) return ipv6Public(ip);
  return false;
}

/**
 * True when the host is a public internet address. Names are resolved and EVERY address must be
 * public. A name that does not resolve rejects with the DNS error.
 */
export async function isPublicHost(hostname: string): Promise<boolean> {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  if (!h) return false;
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return false;
  if (net.isIP(h)) return ipPublic(h);
  const addrs = await dns.promises.lookup(h, { all: true });
  return addrs.length > 0 && addrs.every((a) => ipPublic(a.address));
}

// ───────────────────────────── HTML → tree ─────────────────────────────

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: HNode[];
}
type HNode = El | string;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
  'keygen', 'basefont', 'bgsound', 'frame', 'image',
]);
/** contents are raw text, not markup */
const RAW_TAGS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'title', 'textarea']);
const ESCAPABLE_RAW_TAGS = new Set(['title', 'textarea']);
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template']);
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'dd', 'dt', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);
// "fences": an implied/stray close never crosses these
const P_FENCE = new Set(['button', 'table', 'td', 'th', 'caption', 'template', 'object', 'marquee', 'applet', 'html']);
const LI_FENCE = new Set(['ul', 'ol', 'menu', 'table', 'td', 'th']);
const DL_FENCE = new Set(['dl', 'table', 'td', 'th']);
const ROW_FENCE = new Set(['table', 'thead', 'tbody', 'tfoot']);
const CELL_FENCE = new Set(['tr', 'table']);
const TABLE_FENCE = new Set(['table']);
const END_TAG_FENCE = new Set(['td', 'th', 'caption', 'table']);
const SELECT_FENCE = new Set(['select', 'datalist', 'table']);
const MAX_DEPTH = 400;

const TAG_NAME_RE = /[a-zA-Z][^\s/>]*/y;
const ATTR_NAME_RE = /[^\s/>][^\s/>=]*/y;
const UNQUOTED_RE = /[^\s>]*/y;
const closerCache = new Map<string, RegExp>();

function isSpaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function isLetterCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function closeOpen(stack: El[], names: Set<string>, fence: Set<string>): void {
  for (let k = stack.length - 1; k > 0; k--) {
    const t = stack[k]!.tag;
    if (names.has(t)) {
      stack.length = k;
      return;
    }
    if (fence.has(t)) return;
  }
}

const SET_P = new Set(['p']);
const SET_LI = new Set(['li']);
const SET_DTDD = new Set(['dt', 'dd']);
const SET_TR = new Set(['tr']);
const SET_CELL = new Set(['td', 'th']);
const SET_SECTION = new Set(['thead', 'tbody', 'tfoot']);
const SET_OPTION = new Set(['option']);
const SET_OPTION_GROUP = new Set(['option', 'optgroup']);
const SET_A = new Set(['a']);

/** The end tags HTML lets authors omit (and that real sites do omit). */
function closeImplied(stack: El[], name: string): void {
  if (stack.length <= 4 && !HEAD_TAGS.has(name)) {
    const head = stack.findIndex((e) => e.tag === 'head');
    if (head > 0) stack.length = head;
  }
  if (P_CLOSERS.has(name)) closeOpen(stack, SET_P, P_FENCE);
  switch (name) {
    case 'li':
      closeOpen(stack, SET_LI, LI_FENCE);
      break;
    case 'dt':
    case 'dd':
      closeOpen(stack, SET_DTDD, DL_FENCE);
      break;
    case 'tr':
      closeOpen(stack, SET_TR, ROW_FENCE);
      break;
    case 'td':
    case 'th':
      closeOpen(stack, SET_CELL, CELL_FENCE);
      break;
    case 'thead':
    case 'tbody':
    case 'tfoot':
      closeOpen(stack, SET_SECTION, TABLE_FENCE);
      break;
    case 'option':
      closeOpen(stack, SET_OPTION, SELECT_FENCE);
      break;
    case 'optgroup':
      closeOpen(stack, SET_OPTION_GROUP, SELECT_FENCE);
      break;
    case 'a':
      closeOpen(stack, SET_A, P_FENCE);
      break;
    default:
      if (HEADINGS.has(name) && HEADINGS.has(stack[stack.length - 1]!.tag)) stack.length--;
  }
}

function closeElement(stack: El[], name: string): void {
  if (name === 'br') {
    stack[stack.length - 1]!.children.push({ tag: 'br', attrs: {}, children: [] });
    return;
  }
  // stray </body> and </html> are common mid-page; keep whatever follows inside the body
  if (VOID_TAGS.has(name) || name === 'html' || name === 'body') return;
  const fence = TABLE_PARTS.has(name) ? (name === 'table' ? undefined : TABLE_FENCE) : END_TAG_FENCE;
  for (let k = stack.length - 1; k > 0; k--) {
    const t = stack[k]!.tag;
    if (t === name) {
      stack.length = k;
      return;
    }
    if (fence?.has(t)) return;
  }
}

/** A forgiving HTML tokenizer + tree builder (implied end tags, stray end tags, raw-text elements). */
function buildTree(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const n = html.length;
  const top = (): El => stack[stack.length - 1]!;
  const text = (s: string) => {
    if (s) top().children.push(decodeEntities(s, false));
  };
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    const next = html.charCodeAt(i + 1);

    if (next === 33 /* ! */ || next === 63 /* ? */) {
      // comment, doctype, CDATA, processing instruction
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end === -1 ? n : end + 3;
      } else {
        const end = html.indexOf('>', i + 2);
        i = end === -1 ? n : end + 1;
      }
      continue;
    }
    if (next === 47 /* / */) {
      TAG_NAME_RE.lastIndex = i + 2;
      const m = TAG_NAME_RE.exec(html);
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      if (m) closeElement(stack, m[0].toLowerCase());
      continue;
    }
    if (!isLetterCode(next)) {
      top().children.push('<');
      i++;
      continue;
    }

    // start tag
    TAG_NAME_RE.lastIndex = i + 1;
    const name = TAG_NAME_RE.exec(html)![0].toLowerCase();
    let j = TAG_NAME_RE.lastIndex;
    const attrs = Object.create(null) as Record<string, string>;
    let selfClosing = false;
    for (;;) {
      while (j < n) {
        const c = html.charCodeAt(j);
        if (c === 47) {
          if (html.charCodeAt(j + 1) === 62) selfClosing = true;
          j++;
        } else if (isSpaceCode(c)) j++;
        else break;
      }
      if (j >= n) break;
      if (html.charCodeAt(j) === 62 /* > */) {
        j++;
        break;
      }
      ATTR_NAME_RE.lastIndex = j;
      const am = ATTR_NAME_RE.exec(html);
      if (!am) {
        j++;
        continue;
      }
      const attrName = am[0].toLowerCase();
      j = ATTR_NAME_RE.lastIndex;
      while (j < n && isSpaceCode(html.charCodeAt(j))) j++;
      let value = '';
      if (html.charCodeAt(j) === 61 /* = */) {
        j++;
        while (j < n && isSpaceCode(html.charCodeAt(j))) j++;
        const q = html.charCodeAt(j);
        if (q === 34 || q === 39) {
          const close = html.indexOf(q === 34 ? '"' : "'", j + 1);
          value = html.slice(j + 1, close === -1 ? n : close);
          j = close === -1 ? n : close + 1;
        } else {
          UNQUOTED_RE.lastIndex = j;
          value = UNQUOTED_RE.exec(html)![0];
          j = UNQUOTED_RE.lastIndex;
        }
      }
      if (!(attrName in attrs)) attrs[attrName] = value.includes('&') ? decodeEntities(value, true) : value;
    }
    i = j;

    if (RAW_TAGS.has(name) && !selfClosing) {
      let closer = closerCache.get(name);
      if (!closer) {
        closer = new RegExp(`</${name}[\\s/>]`, 'gi');
        closerCache.set(name, closer);
      }
      closer.lastIndex = i;
      const m = closer.exec(html);
      const end = m ? m.index : n;
      const el: El = { tag: name, attrs, children: [] };
      if (ESCAPABLE_RAW_TAGS.has(name)) el.children.push(decodeEntities(html.slice(i, end), false));
      else if (name === 'script' && /ld\+json/i.test(attrs.type ?? '')) el.children.push(html.slice(i, end));
      if (name !== 'title' && name !== 'script' && name !== 'style') closeImplied(stack, name);
      top().children.push(el);
      if (m) {
        const gt = html.indexOf('>', end);
        i = gt === -1 ? n : gt + 1;
      } else i = n;
      continue;
    }

    closeImplied(stack, name);
    const el: El = { tag: name, attrs, children: [] };
    top().children.push(el);
    if (!selfClosing && !VOID_TAGS.has(name) && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

// ───────────────────────────── entities ─────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', minus: '−',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', ldquo: '“', rdquo: '”', bdquo: '„', lsquo: '‘', rsquo: '’',
  sbquo: '‚', hellip: '…', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢',
  curren: '¤', deg: '°', plusmn: '±', times: '×', divide: '÷', middot: '·', bull: '•', sect: '§', para: '¶',
  numero: '№', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', shy: '',
  zwnj: '', zwj: '', lrm: '', rlm: '', thinsp: ' ', ensp: ' ', emsp: ' ', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', prime: '′', Prime: '″', iexcl: '¡',
  iquest: '¿', ordm: 'º', ordf: 'ª', dagger: '†', szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  check: '✓', star: '☆', starf: '★', phone: '☎', AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '©', REG: '®',
};
const ACCENTS: Record<string, string> = {
  acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', ring: '\u030a',
  cedil: '\u0327', caron: '\u030c',
};
const CP1252_C1: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹',
  140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™',
  154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};
// named entities need ';' — except the few legacy ones browsers accept bare in text ("&nbsp", "&copy 2024")
const ENTITY_TEXT_RE = /&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31});|(amp|lt|gt|quot|nbsp|copy|reg)(?![a-zA-Z0-9=]))/g;
const ENTITY_ATTR_RE = /&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g;

function fromCodePoint(n: number): string {
  if (n >= 128 && n <= 159) return CP1252_C1[n] ?? '';
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(n);
}

function decodeEntities(s: string, inAttr: boolean): string {
  if (!s.includes('&')) return s;
  return s.replace(
    inAttr ? ENTITY_ATTR_RE : ENTITY_TEXT_RE,
    (m, dec?: string, hex?: string, named?: string, bare?: string) => {
      if (dec) return fromCodePoint(parseInt(dec, 10));
      if (hex) return fromCodePoint(parseInt(hex, 16));
      const name = named ?? bare ?? '';
      const known = NAMED_ENTITIES[name];
      if (known !== undefined) return known;
      const acc = /^([a-zA-Z])(acute|grave|circ|uml|tilde|ring|cedil|caron)$/.exec(name);
      if (acc) return (acc[1]! + ACCENTS[acc[2]!]!).normalize('NFC');
      return m;
    },
  );
}

// ───────────────────────────── tree → text ─────────────────────────────

/** never part of the readable text */
const DROP_TAGS = new Set([
  'head', 'script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'title', 'select', 'datalist',
  'textarea', 'object', 'embed', 'video', 'audio', 'map', 'dialog', 'xmp', 'noembed', 'noframes',
]);
/** page chrome, dropped from the main text (links and contacts are harvested from the whole document first) */
const NOISE_TAGS = new Set(['nav', 'aside', 'header', 'footer']);
const NOISE_ROLES = new Set(['navigation', 'search', 'dialog', 'alertdialog', 'complementary']);
const CHROME_ROLES = new Set(['banner', 'contentinfo']);
const NOISE_ATTR_RE = /cookie|consent|gdpr|popup|pop-up|modal|age-?gate|age-?verif|age-?check/i;
const CONTENT_TAGS = new Set(['article', 'main', 'section']);
const BLOCK_TAGS = new Set([
  'html', 'body', 'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'legend', 'main', 'nav', 'section',
  'summary', 'tr', 'td', 'th', 'caption', 'tbody', 'thead', 'tfoot', 'option', 'frameset', 'h4', 'h5', 'h6',
]);

class TextWriter {
  readonly lines: string[] = [];
  private cur = '';
  private prefix = '';

  add(s: string): void {
    this.cur += s;
  }

  /** ends the current line; a pending list/heading prefix waits for the first non-empty line */
  br(): void {
    if (!this.cur) return;
    const t = this.cur.replace(/\s+/g, ' ').trim();
    this.cur = '';
    if (t) {
      this.lines.push(this.prefix + t);
      this.prefix = '';
    }
  }

  para(): void {
    this.br();
    if (this.lines.length && this.lines[this.lines.length - 1] !== '') this.lines.push('');
  }

  setPrefix(p: string): void {
    this.br();
    this.prefix = p;
  }

  clearPrefix(): void {
    this.br();
    this.prefix = '';
  }

  line(s: string): void {
    this.clearPrefix();
    this.lines.push(s);
  }

  finish(): string[] {
    this.br();
    return this.lines;
  }
}

interface WalkCtx {
  dropNoise: boolean;
  inContent: boolean;
  listDepth: number;
  pre: boolean;
  inCell: boolean;
}

const textLenMemo = new WeakMap<El, number>();
function textLength(el: El): number {
  const memo = textLenMemo.get(el);
  if (memo !== undefined) return memo;
  let len = 0;
  for (const c of el.children) len += typeof c === 'string' ? c.trim().length : DROP_TAGS.has(c.tag) ? 0 : textLength(c);
  textLenMemo.set(el, len);
  return len;
}

function isNoise(el: El, ctx: WalkCtx): boolean {
  const tag = el.tag;
  if (NOISE_TAGS.has(tag)) return !((tag === 'header' || tag === 'footer') && ctx.inContent); // an article's own header holds its title
  const role = el.attrs.role?.toLowerCase();
  if (role && (NOISE_ROLES.has(role) || (CHROME_ROLES.has(role) && !ctx.inContent))) return true;
  if (el.attrs['aria-modal'] === 'true') return true;
  if (tag === 'html' || tag === 'body' || tag === 'main' || tag === 'article') return false;
  const cls = el.attrs.class;
  const id = el.attrs.id;
  if ((cls && NOISE_ATTR_RE.test(cls)) || (id && NOISE_ATTR_RE.test(id))) {
    return textLength(el) < 3000; // a banner/modal, not a page wrapper that happens to be called "popup-..."
  }
  return false;
}

function walkChildren(el: El, w: TextWriter, ctx: WalkCtx): void {
  for (const c of el.children) walk(c, w, ctx);
}

function walk(node: HNode, w: TextWriter, ctx: WalkCtx): void {
  if (typeof node === 'string') {
    if (!ctx.pre) {
      w.add(node);
      return;
    }
    const parts = node.split('\n');
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) w.br();
      w.add(parts[k]!);
    }
    return;
  }
  const tag = node.tag;
  if (DROP_TAGS.has(tag)) return;
  if (ctx.dropNoise && isNoise(node, ctx)) return;
  switch (tag) {
    case 'br':
      w.br();
      return;
    case 'hr':
      w.para();
      return;
    case 'img':
      return;
    case 'table':
      renderTable(node, w, ctx);
      return;
    case 'h1':
    case 'h2':
    case 'h3':
      if (ctx.inCell) break;
      w.para();
      w.setPrefix('## ');
      walkChildren(node, w, ctx);
      w.clearPrefix();
      w.para();
      return;
    case 'p':
    case 'blockquote':
      if (ctx.listDepth > 0 || ctx.inCell) break;
      w.para();
      walkChildren(node, w, ctx);
      w.para();
      return;
    case 'pre':
      w.para();
      walkChildren(node, w, { ...ctx, pre: true });
      w.para();
      return;
    case 'li':
      if (ctx.inCell) break;
      w.setPrefix(`${'  '.repeat(Math.max(0, ctx.listDepth - 1))}- `);
      walkChildren(node, w, ctx);
      w.clearPrefix();
      return;
    case 'ul':
    case 'ol':
    case 'menu': {
      if (ctx.inCell) break;
      const outer = ctx.listDepth === 0;
      if (outer) w.para();
      else w.br();
      walkChildren(node, w, { ...ctx, listDepth: ctx.listDepth + 1 });
      if (outer) w.para();
      else w.br();
      return;
    }
  }
  if (BLOCK_TAGS.has(tag) || tag === 'p' || tag === 'li' || tag === 'ul' || tag === 'ol' || HEADINGS.has(tag)) {
    w.br();
    walkChildren(node, w, CONTENT_TAGS.has(tag) && !ctx.inContent ? { ...ctx, inContent: true } : ctx);
    w.br();
    return;
  }
  walkChildren(node, w, ctx);
}

function containsTag(el: El, tag: string): boolean {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.tag === tag || containsTag(c, tag)) return true;
  }
  return false;
}

function cellText(cell: El, ctx: WalkCtx): string {
  const w = new TextWriter();
  walkChildren(cell, w, { ...ctx, inCell: true, listDepth: 0 });
  return w
    .finish()
    .filter(Boolean)
    .join(' ')
    .replace(/\|/g, '/')
    .trim();
}

/** Data tables become '| a | b |' rows; layout tables (nested, one column, long cells) are read as plain blocks. */
function renderTable(table: El, w: TextWriter, ctx: WalkCtx): void {
  if (ctx.inCell) {
    walkChildren(table, w, ctx);
    return;
  }
  const rows: El[] = [];
  const other: HNode[] = [];
  const collect = (el: El) => {
    for (const c of el.children) {
      if (typeof c !== 'string' && c.tag === 'tr') rows.push(c);
      else if (typeof c !== 'string' && (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot')) collect(c);
      else other.push(c);
    }
  };
  collect(table);
  const grid = rows.map((r) =>
    r.children.filter((c): c is El => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')),
  );
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  if (cols >= 2 && !containsTag(table, 'table')) {
    const texts = grid.map((r) => r.map((c) => cellText(c, ctx)));
    const all = texts.flat();
    const total = all.reduce((s, t) => s + t.length, 0);
    if (all.length && total / all.length <= 200 && all.every((t) => t.length <= 600)) {
      w.para();
      for (const c of other) walk(c, w, ctx);
      w.br();
      for (const r of texts) if (r.some(Boolean)) w.line(`| ${r.join(' | ')} |`);
      w.para();
      return;
    }
  }
  w.br();
  walkChildren(table, w, ctx);
  w.br();
}

const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

function cleanLines(lines: string[]): string {
  const out: string[] = [];
  let lastText = '';
  for (const raw of lines) {
    const line = raw.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '').trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (!LETTER_OR_DIGIT_RE.test(line)) continue; // pure punctuation: "|", "•", "***", "→"
    if (line === lastText) continue; // carousels and sticky headers repeat themselves
    out.push(line);
    lastText = line;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function render(el: El, ctx: WalkCtx): string {
  const w = new TextWriter();
  walk(el, w, ctx);
  return cleanLines(w.finish());
}

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'select', 'textarea']);

function textOf(el: El, max = 2000): string {
  let s = '';
  const go = (e: El) => {
    for (const c of e.children) {
      if (s.length > max) return;
      if (typeof c === 'string') s += c;
      else if (!SKIP_TEXT_TAGS.has(c.tag)) {
        const block = BLOCK_TAGS.has(c.tag) || c.tag === 'br' || c.tag === 'p' || c.tag === 'li' || HEADINGS.has(c.tag);
        if (block) s += ' ';
        go(c);
        if (block) s += ' ';
      }
    }
  };
  go(el);
  return collapse(s).slice(0, max);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ───────────────────────────── page parsing ─────────────────────────────

interface Contacts {
  emails: string[];
  phones: string[];
  messengers: string[];
}

interface ParsedHtml {
  title: string;
  description?: string;
  lang?: string;
  text: string;
  links: PageLink[];
  contacts: Contacts;
  refresh?: string;
}

interface Scan {
  lang?: string;
  title?: string;
  metas: Map<string, string>;
  baseHref?: string;
  anchors: El[];
  body?: El;
  mains: El[];
  articles: El[];
  h1?: El;
  jsonLd: string[];
  cfEmails: string[];
}

function scanTree(root: El): Scan {
  const r: Scan = { metas: new Map(), anchors: [], mains: [], articles: [], jsonLd: [], cfEmails: [] };
  const visit = (el: El, inSvg: boolean) => {
    const a = el.attrs;
    switch (el.tag) {
      case 'html': {
        const lang = (a.lang ?? a['xml:lang'])?.trim();
        if (r.lang === undefined && lang) r.lang = lang;
        break;
      }
      case 'title':
        if (!inSvg && r.title === undefined) r.title = textOf(el, 300);
        return;
      case 'meta': {
        const key = (a.name ?? a.property ?? a['http-equiv'] ?? '').trim().toLowerCase();
        if (key && a.content !== undefined && !r.metas.has(key)) r.metas.set(key, a.content);
        return;
      }
      case 'base':
        if (r.baseHref === undefined && a.href) r.baseHref = a.href;
        return;
      case 'a':
      case 'area':
        if (a.href) r.anchors.push(el);
        break;
      case 'body':
        r.body ??= el;
        break;
      case 'main':
        r.mains.push(el);
        break;
      case 'article':
        r.articles.push(el);
        break;
      case 'h1':
        r.h1 ??= el;
        break;
      case 'script': {
        const raw = el.children[0];
        if (typeof raw === 'string') r.jsonLd.push(raw); // only ld+json scripts keep their contents
        return;
      }
      case 'svg':
        inSvg = true;
        break;
    }
    if (el.tag !== 'main' && a.role?.toLowerCase() === 'main') r.mains.push(el);
    if (a['data-cfemail']) r.cfEmails.push(a['data-cfemail']);
    for (const c of el.children) if (typeof c !== 'string') visit(c, inSvg);
  };
  visit(root, false);
  return r;
}

function parseRefresh(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const m = /^\s*(\d+)?[^;,]*[;,]\s*(?:url\s*=\s*)?["']?([^"'\s][^"']*)/i.exec(content);
  if (!m || Number(m[1] ?? 0) > 5) return undefined;
  return m[2]!.trim();
}

function parseHtml(html: string, baseUrl: string): ParsedHtml {
  const root = buildTree(html);
  const info = scanTree(root);
  let base: URL | undefined;
  try {
    base = new URL(baseUrl);
  } catch {
    base = undefined;
  }
  if (info.baseHref) {
    try {
      base = new URL(info.baseHref, base);
    } catch {
      /* keep the page URL */
    }
  }

  // links and contacts come from the whole document — footers hold the contacts
  const links: PageLink[] = [];
  const linkIndex = new Map<string, number>();
  const emails: string[] = [];
  const phones: string[] = [];
  const messengers: string[] = [];
  for (const a of info.anchors) {
    const href = (a.attrs.href ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|data|vbscript):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol === 'mailto:') {
      for (const e of safeDecode(u.pathname).split(/[,;]/)) addEmail(emails, e);
      continue;
    }
    if (u.protocol === 'tel:' || u.protocol === 'callto:') {
      const p = normalizeTel(safeDecode(u.pathname));
      if (p) pushUnique(phones, p);
      continue;
    }
    const messenger = messengerOf(u);
    if (messenger) pushUnique(messengers, messenger);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.pathname.includes('/cdn-cgi/l/email-protection')) {
      addEmail(emails, decodeCfEmail(u.hash.slice(1)) ?? '');
      continue;
    }
    u.hash = '';
    const text = textOf(a, 200) || collapse(a.attrs.title ?? a.attrs['aria-label'] ?? '') || imgAlt(a);
    const known = linkIndex.get(u.href);
    if (known === undefined) {
      if (links.length < 1000) {
        linkIndex.set(u.href, links.length);
        links.push({ text, url: u.href });
      }
    } else if (!links[known]!.text && text) {
      links[known]!.text = text;
    }
  }
  for (const hex of info.cfEmails) addEmail(emails, decodeCfEmail(hex) ?? '');

  const ctx: WalkCtx = { dropNoise: true, inContent: false, listDepth: 0, pre: false, inCell: false };
  let text = '';
  const candidates = [...info.mains];
  if (info.articles.length === 1) candidates.push(info.articles[0]!);
  for (const c of candidates) {
    const t = render(c, { ...ctx, inContent: true });
    if (t.length > 500) {
      text = t;
      break;
    }
  }
  if (!text) text = render(info.body ?? root, ctx);
  const fullText = render(root, { ...ctx, dropNoise: false });
  // everything sat inside something that looked like chrome — better noisy than empty
  if (text.length < 200 && fullText.length > text.length + 200) text = fullText;

  const contacts = extractContacts([fullText, ...info.jsonLd], { emails, phones, messengers });

  const meta = (k: string) => {
    const v = info.metas.get(k);
    return v ? collapse(v) : undefined;
  };
  const title = collapse(info.title ?? '') || meta('og:title') || (info.h1 ? textOf(info.h1, 300) : '');
  const description = (meta('description') ?? meta('og:description') ?? meta('twitter:description'))?.slice(0, 1000);
  const lang = info.lang ?? meta('content-language') ?? meta('language');

  const out: ParsedHtml = { title: title.slice(0, 300), text, links, contacts };
  if (description) out.description = description;
  if (lang) out.lang = lang;
  const refresh = parseRefresh(info.metas.get('refresh'));
  if (refresh) out.refresh = refresh;
  return out;
}

function imgAlt(a: El): string {
  for (const c of a.children) {
    if (typeof c === 'string') continue;
    if (c.tag === 'img' && c.attrs.alt) return collapse(c.attrs.alt);
    const inner = imgAlt(c);
    if (inner) return inner;
  }
  return '';
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Readable text + light Markdown, metadata and all links (absolute, deduped, no #fragments). */
export function htmlToText(
  html: string,
  baseUrl: string,
): { title: string; description?: string; lang?: string; text: string; links: PageLink[] } {
  const p = parseHtml(html, baseUrl);
  const out: { title: string; description?: string; lang?: string; text: string; links: PageLink[] } = {
    title: p.title,
    text: p.text,
    links: p.links,
  };
  if (p.description) out.description = p.description;
  if (p.lang) out.lang = p.lang;
  return out;
}

// ───────────────────────────── contacts ─────────────────────────────

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const NOT_EMAIL_TLD_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|css|js|json|woff2?|ttf|eot|mp4|webm|php|html?)$/i;
const NOISE_EMAIL_DOMAIN_RE =
  /(^|\.)(example\.(com|org|net)|sentry\.io|wixpress\.com|domain\.com|yourdomain\.com|your-domain\.com|mysite\.com|email\.com)$/i;
const INTL_PHONE_RE = /\+[ \t\u00a0]?\(?\d[\d \t\u00a0().\-–]{7,22}\d/g;
// Ukrainian local formats, only with separators: "(044) 123-45-67", "067 123 45 67", "38 (050) 123 45 67"
const UA_PHONE_RE =
  /(?<![\d+])(?:\+?38[ \t\u00a0-]?)?\(0\d{2}\)[ \t\u00a0-]?\d{3}[ \t\u00a0-]?\d{2}[ \t\u00a0-]?\d{2}(?![\d])|(?<![\d+\-])\b0\d{2}[ \t\u00a0-]\d{3}[ \t\u00a0-]\d{2}[ \t\u00a0-]\d{2}(?![\d-])/g;
const MESSENGER_TEXT_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me|wa\.me)\/[A-Za-z0-9_+]{3,}/g;

function pushUnique(list: string[], value: string): void {
  if (value && list.length < MAX_CONTACTS && !list.includes(value)) list.push(value);
}

function addEmail(list: string[], raw: string): void {
  let e = raw.trim().replace(/^mailto:/i, '').split('?')[0]!.trim().toLowerCase();
  e = e.replace(/^u00[0-9a-f]{2}/, ''); // "<info@site.ua" inside JSON
  e = e.replace(/[.,;:]+$/, '');
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return;
  const domain = e.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(domain)) return;
  if (NOT_EMAIL_TLD_RE.test(e) || NOISE_EMAIL_DOMAIN_RE.test(domain)) return;
  pushUnique(list, e);
}

function decodeCfEmail(hex: string): string | undefined {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return undefined;
  const key = parseInt(hex.slice(0, 2), 16);
  let s = '';
  for (let k = 2; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16) ^ key);
  return s;
}

function normalizeTel(raw: string): string | undefined {
  const s = raw.trim();
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 7 && d.length <= 15 ? `+${d}` : undefined;
  if (d.startsWith('00') && d.length >= 9 && d.length <= 17) return `+${d.slice(2)}`;
  if (d.length === 10 && d.startsWith('0')) return `+38${d}`;
  if (d.length === 12 && d.startsWith('380')) return `+${d}`;
  return d.length >= 3 && d.length <= 15 ? d : undefined;
}

function normalizeIntlPhone(raw: string): string | undefined {
  let d = raw.replace(/\D/g, '');
  // the greedy match may run into a trailing number ("+38 044 123 45 67 10:00"): known lengths win
  if (d.startsWith('380')) {
    if (d.length < 12) return undefined;
    d = d.slice(0, 12);
  } else if ((d.startsWith('7') || d.startsWith('1')) && d.length > 11) {
    d = d.slice(0, 11);
  }
  return d.length >= 10 && d.length <= 15 ? `+${d}` : undefined;
}

function normalizeLocalPhone(raw: string): string | undefined {
  const d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return `+${d}`;
  if (d.length === 10 && d.startsWith('0')) return `+38${d}`;
  return undefined;
}

function messengerOf(u: URL): string | undefined {
  const p = u.protocol;
  const href = u.href;
  if (p === 'viber:' || p === 'whatsapp:' || p === 'tg:') {
    if (/forward|text=/i.test(href) && !/number=|phone=|resolve|domain=/i.test(href)) return undefined; // share buttons
    return href;
  }
  if (p !== 'http:' && p !== 'https:') return undefined;
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const clean = () => {
    const c = new URL(href);
    c.hash = '';
    return c.href;
  };
  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
    if (!path || /^\/(share|joinchat\/?$|iv)/.test(path)) return undefined;
    return clean();
  }
  if (host === 'wa.me') return path ? clean() : undefined;
  if (host === 'api.whatsapp.com' || host === 'web.whatsapp.com' || host === 'chat.whatsapp.com') {
    if (host !== 'chat.whatsapp.com' && !u.searchParams.get('phone')) return undefined;
    return clean();
  }
  if (host === 'invite.viber.com' || host === 'chats.viber.com' || host === 'viber.click') return path || u.search ? clean() : undefined;
  return undefined;
}

/** Contacts from free text (emails, phone numbers, messenger URLs), appended to what links already gave. */
function extractContacts(texts: string[], seed?: Contacts): Contacts {
  const emails = [...(seed?.emails ?? [])];
  const phones = [...(seed?.phones ?? [])];
  const messengers = [...(seed?.messengers ?? [])];
  for (const raw of texts) {
    const t = raw.length > 1_000_000 ? raw.slice(0, 1_000_000) : raw;
    for (const m of t.matchAll(EMAIL_RE)) addEmail(emails, m[0]);
    for (const m of t.matchAll(INTL_PHONE_RE)) {
      const p = normalizeIntlPhone(m[0]);
      if (p) pushUnique(phones, p);
    }
    for (const m of t.matchAll(UA_PHONE_RE)) {
      const p = normalizeLocalPhone(m[0]);
      if (p) pushUnique(phones, p);
    }
    for (const m of t.matchAll(MESSENGER_TEXT_RE)) {
      const url = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
      try {
        const msg = messengerOf(new URL(url));
        if (msg) pushUnique(messengers, msg);
      } catch {
        /* not a URL after all */
      }
    }
  }
  return { emails, phones, messengers };
}

// ───────────────────────────── key links ─────────────────────────────

/** in priority order; [pattern, how many links of this kind at most in the first pass] */
const KEY_LINK_RULES: Array<[RegExp, number]> = [
  [/contact|kontakt|контакт|zvyazok|zv-yazok|зв.?язок|feedback|зворотн/, 2],
  [/about|\bo[-_]?nas\b|\bpro[-_]?nas\b|(?:^|[^а-яіїєґ])(?:о|про)[- ]нас(?![а-яіїєґ])|o-kompan|pro-kompan|company|kompani|компан|history|istori|історі|истори|who-we-are/, 3],
  [/product(?!ion)|produkt|продукц|продукт|catalog|katalog|каталог|asortyment|assortiment|асортимент|ассортимент/, 3],
  [/production|proizvodstv|vyrobnyc|vyrobnytstv|виробництв|производств|capabilit|можливост|возможност|manufactur|factory|zavod|завод|equipment|obladnan|обладнан|оборудован|technolog|технолог|facilit|потужност/, 3],
  [/services|poslug|uslug|послуг|услуг/, 2],
  [/pric|prais|prajs|прайс|ціни|ціна|цены|цена|tsiny|ceny|wholesale|optom|оптов|dealer|dyler|diler|дилер|partner|партнер/, 2],
  [/certif|sertyf|sertif|сертиф|quality|yakist|якіст|качеств/, 2],
  [/rekviz|реквіз|реквиз|delivery|dostavk|доставк|shipping|oplata|оплат|payment/, 2],
  [/portfolio|портфол|projects|proekt|проєкт|проект|cases|кейс|referenc/, 2],
];
const KEY_LINK_SKIP_RE =
  /(log-?in|log-?out|sign-?in|sign-?up|register|\/search\b|[?&](?:q|s|search)=|cart|basket|korzina|кошик|корзин|checkout|wishlist|compare|my-?account|password|add[-_]to[-_]cart|wp-admin|wp-login|\/feed\/?$|\.(?:jpe?g|png|gif|webp|svg|ico|css|js|zip|rar|7z|mp4|mp3|avi|mov|webm)$)/i;
const KEY_LINK_QUERY_SKIP_RE = /(?:^|[?&])(?:sort|order|limit|filter|page|utm_[a-z]+|add-to-cart|replytocom)=/i;

function siteOf(host: string): string {
  return host.toLowerCase().replace(/^www\d?\./, '');
}

function linkKey(u: URL): string {
  return `${siteOf(u.hostname)}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
}

function pickKeyLinks(links: PageLink[], page: URL): PageLink[] {
  const site = siteOf(page.hostname);
  const seen = new Set<string>([linkKey(page)]);
  const found: Array<{ link: PageLink; cat: number; depth: number; idx: number }> = [];
  links.forEach((l, idx) => {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    const host = siteOf(u.hostname);
    if (host !== site && !host.endsWith(`.${site}`) && !site.endsWith(`.${host}`)) return;
    u.hash = '';
    const key = linkKey(u);
    if (seen.has(key)) return;
    const path = safeDecode(u.pathname);
    const search = safeDecode(u.search);
    if (KEY_LINK_SKIP_RE.test(path + search) || KEY_LINK_QUERY_SKIP_RE.test(u.search)) return;
    const hay = `${path} ${search} ${l.text}`.toLowerCase();
    const cat = KEY_LINK_RULES.findIndex(([re]) => re.test(hay));
    if (cat === -1) return;
    seen.add(key);
    const depth = path.split('/').filter(Boolean).length + (u.search ? 1 : 0);
    let text = collapse(l.text);
    if (text.length > 80) text = `${text.slice(0, 77)}…`;
    found.push({ link: { text: text || path, url: u.href }, cat, depth, idx });
  });
  // section pages first (/catalog before /catalog/boilers/kt-20), then document order
  found.sort((a, b) => a.cat - b.cat || a.depth - b.depth || a.idx - b.idx);
  const perCat = new Map<number, number>();
  const chosen = new Set<(typeof found)[number]>();
  for (const f of found) {
    if (chosen.size >= MAX_KEY_LINKS) break;
    const used = perCat.get(f.cat) ?? 0;
    if (used >= KEY_LINK_RULES[f.cat]![1]) continue;
    perCat.set(f.cat, used + 1);
    chosen.add(f);
  }
  // spare slots go to whatever is left (a catalog page full of category links)
  for (const f of found) {
    if (chosen.size >= MAX_KEY_LINKS) break;
    chosen.add(f);
  }
  return found.filter((f) => chosen.has(f)).map((f) => f.link);
}
