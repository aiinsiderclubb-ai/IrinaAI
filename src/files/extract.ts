/**
 * Turn a file a user sent to the bot into plain text an LLM can read.
 *
 * PDF goes through unpdf (pdf.js); Office files (docx / pptx / xlsx) are ZIPs of XML, unpacked with fflate and
 * walked with a tiny tokenizer below — no XML library. Structure survives as light Markdown: '## ' headings,
 * '- ' list items, '| a | b |' table rows, '### Слайд N' / '### Аркуш «Name»' section headers.
 * Images are not handled here (the caller sends them to vision); old binary Office formats are refused with a
 * Ukrainian message the bot can show as is.
 */
import { unzipSync } from 'fflate';

export interface Extracted {
  /** plain text, structure kept with light Markdown: '## ' headings, '- ' list items, tables as '| a | b |' rows, '### Слайд N' / '### Аркуш «Name»' section headers */
  text: string;
  /** 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'csv' | 'html' | 'json' */
  kind: string;
  /** http(s) links found in the file (hyperlink targets from docx/pptx/xlsx relationships + URLs in the text), deduped, in order, max 200 */
  links: string[];
  /** pages (pdf), slides (pptx), sheets (xlsx) when known */
  units?: number;
  /** true when the text was cut at maxChars */
  truncated?: boolean;
}

/** The file can't be read as text; the message is in Ukrainian and meant for the user. */
export class UnsupportedFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFile';
  }
}

const DEFAULT_MAX_CHARS = 400_000;
const MAX_LINKS = 200;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 200;
/** zip-bomb guard: uncompressed size of one XML part / of everything we inflate */
const MAX_PART_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

const SUPPORTED_HINT = 'надішліть PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV або текстовий файл';
const CORRUPT = 'Не вдалося прочитати файл — схоже, він пошкоджений або має неправильне розширення';
const TOO_BIG = 'Файл завеликий для обробки — розділіть його на менші частини';
const IMAGE_MSG = 'Зображення не обробляються як документ — надішліть його як фото';

// ---------------------------------------------------------------------------------------------------------------
// kinds

const EXT_KIND: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', ppsm: 'pptx', potx: 'pptx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
  txt: 'text', text: 'text', md: 'text', markdown: 'text', log: 'text', yaml: 'text', yml: 'text', xml: 'text',
  srt: 'text', vtt: 'text', ini: 'text', cfg: 'text', conf: 'text',
  csv: 'csv', tsv: 'csv', tab: 'csv',
  json: 'json',
  html: 'html', htm: 'html', xhtml: 'html',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', heic: 'image', heif: 'image',
};

const MIME_KIND: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/json': 'json',
  'text/json': 'json',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/xml': 'text',
  'application/x-yaml': 'text',
};

/** old / foreign formats we refuse, with what to save them as instead */
const SAVE_AS: Record<string, string> = {
  doc: '.docx або PDF', dot: '.docx або PDF', rtf: '.docx або PDF', odt: '.docx або PDF', pages: '.docx або PDF',
  wps: '.docx або PDF',
  xls: '.xlsx або CSV', xlt: '.xlsx або CSV', xlsb: '.xlsx або CSV', ods: '.xlsx або CSV', numbers: '.xlsx або CSV',
  ppt: '.pptx або PDF', pps: '.pptx або PDF', pot: '.pptx або PDF', odp: '.pptx або PDF', key: '.pptx або PDF',
};
const ARCHIVES = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const OOXML_KINDS = new Set(['docx', 'pptx', 'xlsx']);

function extOf(name: string): string | undefined {
  return /\.([a-z0-9]{1,10})$/i.exec(name.trim())?.[1]?.toLowerCase();
}

function unsupportedMessage(ext: string | undefined): string {
  if (!ext) return `Не вдалося визначити формат файлу — ${SUPPORTED_HINT}`;
  if (ARCHIVES.has(ext)) return `Архіви (.${ext}) не підтримуються — розпакуйте й надішліть потрібні файли окремо`;
  const saveAs = SAVE_AS[ext];
  if (saveAs) return `Формат .${ext} не підтримується — збережіть як ${saveAs}`;
  return `Формат .${ext} не підтримується — ${SUPPORTED_HINT}`;
}

/** an OLE2 container: a pre-2007 Office file, or a password-protected new one */
function oleMessage(ext: string | undefined, kind: string | undefined): string {
  if (ext && SAVE_AS[ext]) return unsupportedMessage(ext);
  if (kind === 'docx') return 'Файл захищено паролем або збережено в старому форматі Word (.doc) — зніміть пароль або збережіть як .docx чи PDF';
  if (kind === 'xlsx') return 'Файл захищено паролем або збережено в старому форматі Excel (.xls) — зніміть пароль або збережіть як .xlsx чи CSV';
  if (kind === 'pptx') return 'Файл захищено паролем або збережено в старому форматі PowerPoint (.ppt) — зніміть пароль або збережіть як .pptx чи PDF';
  if (ext && !EXT_KIND[ext]) return unsupportedMessage(ext);
  return 'Старі формати Office (.doc, .xls, .ppt) не підтримуються — збережіть файл як .docx, .xlsx, .pptx або PDF';
}

/**
 * What a file is, from its name (preferred) or MIME type: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text' | 'csv' |
 * 'html' | 'json' | 'image'. undefined = unsupported.
 */
export function fileKind(name: string, mime?: string): string | undefined {
  const ext = extOf(name);
  if (ext) {
    const k = EXT_KIND[ext];
    if (k) return k;
    if (SAVE_AS[ext] || ARCHIVES.has(ext)) return undefined;
  }
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (!m || m === 'image/svg+xml') return undefined;
  const k = MIME_KIND[m];
  if (k) return k;
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('text/')) return 'text';
  return undefined;
}

type Magic = 'pdf' | 'zip' | 'ole' | 'image' | 'binary';

function startsWith(d: Uint8Array, bytes: number[], at = 0): boolean {
  return bytes.every((b, i) => d[at + i] === b);
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** some PDF writers put junk before the header; it must be within the first 1 KB */
function hasPdfHeader(d: Uint8Array): boolean {
  for (let i = 0; i + PDF_HEADER.length <= Math.min(d.length, 1024); i++) if (startsWith(d, PDF_HEADER, i)) return true;
  return false;
}

/** what the bytes say, regardless of the name */
function sniff(d: Uint8Array): Magic | undefined {
  if (startsWith(d, PDF_HEADER)) return 'pdf';
  if (startsWith(d, [0x50, 0x4b]) && (d[2] === 3 || d[2] === 5 || d[2] === 7)) return 'zip';
  if (startsWith(d, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (
    startsWith(d, [0xff, 0xd8, 0xff]) || // jpeg
    startsWith(d, [0x89, 0x50, 0x4e, 0x47]) || // png
    startsWith(d, [0x47, 0x49, 0x46, 0x38]) || // gif
    (startsWith(d, [0x52, 0x49, 0x46, 0x46]) && startsWith(d, [0x57, 0x45, 0x42, 0x50], 8)) // webp
  )
    return 'image';
  if (
    startsWith(d, [0x52, 0x61, 0x72, 0x21]) || // rar
    startsWith(d, [0x37, 0x7a, 0xbc, 0xaf]) || // 7z
    startsWith(d, [0x1f, 0x8b]) // gzip
  )
    return 'binary';
  return undefined;
}

/** no NUL bytes and hardly any control characters in the first 8 KB */
function looksLikeText(d: Uint8Array): boolean {
  const head = d.subarray(0, 8192);
  if (head.includes(0) && !(startsWith(d, [0xff, 0xfe]) || startsWith(d, [0xfe, 0xff]))) return false;
  const s = decodeText(head);
  const ctrl = s.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0;
  return ctrl <= s.length * 0.01;
}

// ---------------------------------------------------------------------------------------------------------------
// entry point

interface Parsed {
  text: string;
  links: string[];
  units?: number;
}

/**
 * Plain text of a document. Throws UnsupportedFile (Ukrainian message for the user) for images, old binary
 * Office formats, archives, encrypted or broken files. A PDF with no text layer (a scan) gives text ''.
 */
export async function extractText(
  data: Uint8Array,
  name: string,
  mime?: string,
  opts: { maxChars?: number } = {},
): Promise<Extracted> {
  const maxChars = Math.max(0, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const ext = extOf(name);
  let kind = fileKind(name, mime);
  const magic = sniff(data);

  if (kind === 'image' || magic === 'image') throw new UnsupportedFile(IMAGE_MSG);
  if (magic === 'ole') throw new UnsupportedFile(oleMessage(ext, kind));
  if (magic === 'pdf' || ((kind === 'pdf' || !kind) && hasPdfHeader(data))) return finish(await extractPdf(data), 'pdf', maxChars);
  if (magic === 'zip') {
    const z = openOoxml(data, ext);
    const parsed =
      z.kind === 'docx' ? extractDocx(z.files, z.main) : z.kind === 'pptx' ? extractPptx(z.files, z.main) : extractXlsx(z.files, z.main);
    return finish(parsed, z.kind, maxChars);
  }
  if (magic === 'binary') throw new UnsupportedFile(kind ? CORRUPT : unsupportedMessage(ext ?? 'zip'));
  // named as PDF / Office, but the bytes are something else
  if (kind === 'pdf' || (kind && OOXML_KINDS.has(kind))) throw new UnsupportedFile(CORRUPT);
  if (!kind) {
    if ((ext && (SAVE_AS[ext] || ARCHIVES.has(ext))) || !looksLikeText(data)) throw new UnsupportedFile(unsupportedMessage(ext));
    kind = 'text';
  }

  const raw = decodeText(data);
  const links: string[] = [];
  let text: string;
  if (kind === 'csv') {
    const m = (mime ?? '').toLowerCase();
    const tab = ext === 'tsv' || ext === 'tab' || m.includes('tab-separated');
    text = csvToTable(raw, tab ? '\t' : undefined);
  } else if (kind === 'json') text = prettyJson(raw);
  else if (kind === 'html') text = htmlToText(raw, links);
  else text = raw;
  return finish({ text, links }, kind, maxChars);
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function finish(p: Parsed, kind: string, maxChars: number): Extracted {
  let text = p.text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();
  const links = dedupe([...p.links.map((l) => l.trim()).filter(isHttp), ...findUrls(text)]).slice(0, MAX_LINKS);
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1); // don't leave half a surrogate pair
    truncated = true;
  }
  const out: Extracted = { text, kind, links };
  if (p.units !== undefined) out.units = p.units;
  if (truncated) out.truncated = true;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// links

function isHttp(s: string): boolean {
  return /^https?:\/\/\S/i.test(s);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** for "is the shown text just the URL itself?" */
function sameUrl(a: string, b: string): boolean {
  const n = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return n(a) === n(b);
}

const URL_RE = /https?:\/\/[^\s<>"«»“”„[\]{}|\\^`]+/gi;
const TRAILING = '.,;:!?»"\'”’…*';

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** http(s) URLs in free text, trailing punctuation ) . , ; » " stripped (a ')' only when unbalanced), deduped */
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let u = m[0];
    for (;;) {
      const last = u.at(-1);
      if (last === undefined) break;
      if (TRAILING.includes(last) || (last === ')' && count(u, '(') < count(u, ')'))) u = u.slice(0, -1);
      else break;
    }
    if (/^https?:\/\/[^/?#]*[\p{L}\p{N}]/iu.test(u)) out.push(u);
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------------------------------------------
// text decoding

/** UTF-8 (BOM stripped), UTF-16 with a BOM, or windows-1251 when UTF-8 decoding gives lots of U+FFFD */
function decodeText(data: Uint8Array): string {
  if (startsWith(data, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(data);
  if (startsWith(data, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    // not valid UTF-8
  }
  const loose = new TextDecoder('utf-8').decode(data);
  const bad = loose.match(/�/g)?.length ?? 0;
  if (bad > Math.max(2, loose.length * 0.005)) {
    try {
      return new TextDecoder('windows-1251').decode(data);
    } catch {
      // runtime without the legacy encodings
    }
  }
  return loose;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', bdquo: '„',
  lsquo: '‘', rsquo: '’', sbquo: '‚', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€',
  deg: '°', plusmn: '±', times: '×', divide: '÷', sect: '§', para: '¶', shy: '', zwnj: '', zwj: '', numero: '№',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', minus: '−', le: '≤', ge: '≥', ne: '≠', frac12: '½', frac14: '¼',
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e.startsWith('#')) {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// XML: a tokenizer good enough for OOXML parts (tags matched by local name, prefixes ignored)

type Tok = { k: 'open' | 'close' | 'self'; local: string; attrs: string } | { k: 'text'; text: string };

const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

/** `at.pos`, when given, is kept at the offset of the token just yielded */
function* xmlTokens(xml: string, at?: { pos: number }): Generator<Tok> {
  const re = new RegExp(XML_TOKEN.source, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (at) at.pos = m.index;
    if (m[6] !== undefined) yield { k: 'text', text: decodeEntities(m[6]) };
    else if (m[3] !== undefined) {
      const name = m[3];
      const local = name.slice(name.indexOf(':') + 1);
      yield { k: m[2] ? 'close' : m[5] ? 'self' : 'open', local, attrs: m[4] ?? '' };
    } else if (m[1] !== undefined) yield { k: 'text', text: m[1] };
  }
}

const attrRes = new Map<string, RegExp>();

/** attribute value by local name (w:val, val, x:val all match 'val') */
function attr(attrs: string, local: string): string | undefined {
  let re = attrRes.get(local);
  if (!re) {
    re = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${local}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrRes.set(local, re);
  }
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : undefined;
}

/** a relationship id: r:id (any prefix), never a bare id="…" */
function relId(attrs: string): string | undefined {
  const m = /(?:^|\s)[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// OOXML package

interface Rel {
  type: string;
  target: string;
  external: boolean;
}

function parseRels(xml: string | undefined): Map<string, Rel> {
  const rels = new Map<string, Rel>();
  if (!xml) return rels;
  for (const t of xmlTokens(xml)) {
    if (t.k === 'text' || t.k === 'close' || t.local !== 'Relationship') continue;
    const id = attr(t.attrs, 'Id');
    const target = attr(t.attrs, 'Target');
    if (id && target !== undefined)
      rels.set(id, { type: attr(t.attrs, 'Type') ?? '', target, external: attr(t.attrs, 'TargetMode') === 'External' });
  }
  return rels;
}

function relUrl(rels: Map<string, Rel>, id: string | undefined): string | undefined {
  const target = id ? rels.get(id)?.target.trim() : undefined;
  return target && isHttp(target) ? target : undefined;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function relsPathFor(part: string): string {
  const dir = dirOf(part);
  const file = dir ? part.slice(dir.length + 1) : part;
  return `${dir ? `${dir}/` : ''}_rels/${file}.rels`;
}

function resolvePath(dir: string, target: string): string {
  const full = target.startsWith('/') ? target.slice(1) : dir ? `${dir}/${target}` : target;
  const out: string[] = [];
  for (const seg of full.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

/** first relationship of a type (by suffix, e.g. '/styles'), as a package path */
function relTarget(rels: Map<string, Rel>, dir: string, typeSuffix: string): string | undefined {
  for (const r of rels.values()) if (!r.external && r.type.endsWith(typeSuffix)) return resolvePath(dir, r.target);
  return undefined;
}

function decodeXmlBytes(b: Uint8Array): string {
  if (startsWith(b, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(b);
  if (startsWith(b, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

function readZip(data: Uint8Array, want: (name: string) => boolean, names?: string[]): Map<string, string> {
  let total = 0;
  let tooBig = false;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(data, {
      filter: (f) => {
        names?.push(f.name);
        if (!want(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    throw new UnsupportedFile(CORRUPT);
  }
  if (tooBig) throw new UnsupportedFile(TOO_BIG);
  const files = new Map<string, string>();
  for (const [name, bytes] of Object.entries(raw)) files.set(name, decodeXmlBytes(bytes));
  return files;
}

const SKIP_PARTS =
  /\/(media|embeddings|pivotCache|printerSettings|charts|drawings|diagrams|theme|customXml|slideLayouts|slideMasters|notesMasters|handoutMasters|tags|fonts|activeX|externalLinks|queryTables|tables)\//;

/** a ZIP: which Office document it is (by its content, not its name) and its XML parts */
function openOoxml(data: Uint8Array, ext: string | undefined): { kind: 'docx' | 'pptx' | 'xlsx'; main: string; files: Map<string, string> } {
  const names: string[] = [];
  const root = readZip(data, (n) => n === '_rels/.rels', names);
  const present = new Set(names);
  let main = relTarget(parseRels(root.get('_rels/.rels')), '', '/officeDocument');
  if (!main || !present.has(main)) main = ['word/document.xml', 'ppt/presentation.xml', 'xl/workbook.xml'].find((n) => present.has(n));
  const top = main?.split('/')[0];
  const kind = top === 'word' ? 'docx' : top === 'ppt' ? 'pptx' : top === 'xl' ? 'xlsx' : undefined;
  if (!main || !kind) {
    if (present.has('mimetype') && present.has('content.xml'))
      throw new UnsupportedFile(
        ext && SAVE_AS[ext] ? unsupportedMessage(ext) : 'Формат OpenDocument не підтримується — збережіть як .docx, .xlsx або PDF',
      );
    const declared = ext ? EXT_KIND[ext] : undefined;
    if (declared && OOXML_KINDS.has(declared)) throw new UnsupportedFile(CORRUPT);
    throw new UnsupportedFile(unsupportedMessage(ext && !EXT_KIND[ext] ? ext : 'zip'));
  }
  const files = readZip(data, (n) => n.startsWith(`${top}/`) && /\.(xml|rels)$/i.test(n) && !SKIP_PARTS.test(n));
  return { kind, main, files };
}

/** collects table rows; paragraphs inside a cell go to the cell, finished tables to `out` (or the outer cell) */
class Tables {
  private stack: { rows: string[][]; row?: string[]; cell?: string[]; span: number }[] = [];
  constructor(private readonly out: string[]) {}

  /** a finished paragraph: into the open cell, else straight out */
  line(text: string): void {
    const cell = this.stack.at(-1)?.cell;
    if (cell) cell.push(text);
    else this.out.push(text);
  }

  get inCell(): boolean {
    return this.stack.at(-1)?.cell !== undefined;
  }

  span(n: number): void {
    const tb = this.stack.at(-1);
    if (tb && Number.isFinite(n)) tb.span = Math.max(1, Math.min(n, 64));
  }

  /** handles tbl / tr / tc; false for any other tag */
  tag(local: string, k: 'open' | 'close' | 'self'): boolean {
    if (local === 'tbl') {
      if (k === 'open') this.stack.push({ rows: [], span: 1 });
      else if (k === 'close') {
        const tb = this.stack.pop();
        const rows = (tb?.rows ?? []).filter((r) => r.some((c) => c !== '')).map((r) => `| ${r.join(' | ')} |`);
        if (rows.length) {
          if (this.inCell) this.line(rows.join(' '));
          else this.out.push('', ...rows, '');
        }
      }
      return true;
    }
    const tb = this.stack.at(-1);
    if (!tb || (local !== 'tr' && local !== 'tc')) return false;
    if (local === 'tr') {
      if (k === 'open') tb.row = [];
      else if (k === 'close' && tb.row) {
        tb.rows.push(tb.row);
        tb.row = undefined;
      }
      return true;
    }
    if (k === 'open') {
      tb.cell = [];
      tb.span = 1;
    } else {
      const text = cellText((tb.cell ?? []).filter((l) => l.trim()).join(' '));
      tb.row?.push(text, ...Array<string>(tb.span - 1).fill(''));
      tb.cell = undefined;
    }
    return true;
  }
}

function cellText(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

/** "shown text (url)" unless the shown text is the URL already */
function appendUrl(p: { text: string }, start: number, url: string): void {
  const shown = p.text.slice(start).trim();
  if (!shown) p.text += url;
  else if (!sameUrl(shown, url)) p.text += ` (${url})`;
}

// ---------------------------------------------------------------------------------------------------------------
// DOCX

interface DocxStyle {
  name?: string;
  outline?: number;
  list?: boolean;
}

function parseDocxStyles(xml: string | undefined): Map<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>();
  if (!xml) return styles;
  let cur: DocxStyle | undefined;
  let id: string | undefined;
  for (const t of xmlTokens(xml)) {
    if (t.k === 'text') continue;
    if (t.local === 'style') {
      if (t.k === 'open') {
        cur = {};
        id = attr(t.attrs, 'styleId');
      } else if (t.k === 'close') {
        if (cur && id) styles.set(id, cur);
        cur = undefined;
      }
    } else if (cur && t.k !== 'close') {
      if (t.local === 'name') cur.name = attr(t.attrs, 'val');
      else if (t.local === 'outlineLvl') cur.outline = Number(attr(t.attrs, 'val'));
      else if (t.local === 'numPr') cur.list = true;
    }
  }
  return styles;
}

const HEADING_RE = /(heading|заголов|title)\s*\d/i;

function isHeading(styleId: string | undefined, styles: Map<string, DocxStyle>): boolean {
  if (!styleId) return false;
  const s = styles.get(styleId);
  for (const n of [styleId, s?.name ?? '']) if (HEADING_RE.test(n) || /^(title|назва)$/i.test(n.trim())) return true;
  if (!s && /^[1-9]$/.test(styleId)) return true; // localized Word names "Заголовок 1" with styleId "1"
  return s?.outline !== undefined && s.outline >= 0 && s.outline < 9;
}

interface DocxPara {
  text: string;
  style?: string;
  list: boolean;
  level: number;
  links: { url?: string; start: number }[];
  instr: string;
  field?: { url: string; start: number };
}

/** elements whose content is not part of the visible text (VML fallbacks, tracked deletions and old formatting) */
const DOCX_SKIP = new Set(['Fallback', 'del', 'moveFrom', 'pPrChange', 'rPrChange']);

function extractDocx(files: Map<string, string>, main: string): Parsed {
  const xml = files.get(main);
  if (xml === undefined) throw new UnsupportedFile(CORRUPT);
  const rels = parseRels(files.get(relsPathFor(main)));
  const styles = parseDocxStyles(files.get(relTarget(rels, dirOf(main), '/styles') ?? 'word/styles.xml'));
  const out: string[] = [];
  const links: string[] = [];
  const tables = new Tables(out);
  const paras: DocxPara[] = [];
  let runDepth = 0;
  let inT = false;
  let inInstr = false;
  let skip: string | undefined;
  let skipDepth = 0;

  const endPara = (p: DocxPara) => {
    if (p.field) appendUrl(p, p.field.start, p.field.url);
    const text = p.text;
    if (!text.trim()) return tables.line('');
    if (isHeading(p.style, styles)) {
      if (!tables.inCell) tables.line('');
      return tables.line(`## ${text.replace(/\s*\n\s*/g, ' ').trim()}`);
    }
    if (p.list || (p.style && styles.get(p.style)?.list)) return tables.line(`${'  '.repeat(Math.min(p.level, 5))}- ${text.trim()}`);
    tables.line(text);
  };

  for (const t of xmlTokens(xml)) {
    if (skip) {
      if (t.k !== 'text' && t.local === skip) {
        if (t.k === 'open') skipDepth++;
        else if (t.k === 'close' && --skipDepth === 0) skip = undefined;
      }
      continue;
    }
    const p = paras.at(-1);
    if (t.k === 'text') {
      if (p && inT) p.text += t.text;
      else if (p && inInstr) p.instr += t.text;
      continue;
    }
    if (tables.tag(t.local, t.k)) continue;
    const on = t.k !== 'close';
    if (DOCX_SKIP.has(t.local)) {
      if (t.k === 'open') {
        skip = t.local;
        skipDepth = 1;
      }
      continue;
    }
    switch (t.local) {
      case 'p':
        if (t.k === 'open') paras.push({ text: '', list: false, level: 0, links: [], instr: '' });
        else if (t.k === 'self') tables.line('');
        else {
          const done = paras.pop();
          if (done) endPara(done);
        }
        break;
      case 'pStyle':
        if (p && on) p.style = attr(t.attrs, 'val');
        break;
      case 'numPr':
        if (p && t.k === 'open') p.list = true;
        break;
      case 'ilvl':
        if (p && on) p.level = Number(attr(t.attrs, 'val')) || 0;
        break;
      case 'numId':
        if (p && on && attr(t.attrs, 'val') === '0') p.list = false; // numbering explicitly removed
        break;
      case 'gridSpan':
        if (on) tables.span(Number(attr(t.attrs, 'val')));
        break;
      case 'r':
        if (t.k === 'open') runDepth++;
        else if (t.k === 'close') runDepth = Math.max(0, runDepth - 1);
        break;
      case 't':
        inT = t.k === 'open';
        break;
      case 'instrText':
        inInstr = t.k === 'open';
        break;
      case 'tab':
      case 'ptab':
        if (p && on && runDepth > 0) p.text += '\t';
        break;
      case 'br':
      case 'cr':
        if (p && on && runDepth > 0) p.text += '\n';
        break;
      case 'noBreakHyphen':
        if (p && on && runDepth > 0) p.text += '-';
        break;
      case 'hyperlink':
        if (!p) break;
        if (t.k === 'open') {
          const url = relUrl(rels, relId(t.attrs));
          if (url) links.push(url);
          p.links.push({ url, start: p.text.length });
        } else if (t.k === 'close') {
          const h = p.links.pop();
          if (h?.url) appendUrl(p, h.start, h.url);
        }
        break;
      case 'fldChar': {
        if (!p || !on) break;
        const type = attr(t.attrs, 'fldCharType');
        if (type === 'begin') {
          p.instr = '';
          p.field = undefined;
        } else if (type === 'separate') {
          const m = /HYPERLINK\s+(?:"([^"]+)"|(\S+))/i.exec(p.instr);
          const url = (m?.[1] ?? m?.[2])?.trim();
          if (url && isHttp(url)) {
            links.push(url);
            p.field = { url, start: p.text.length };
          }
        } else if (type === 'end') {
          if (p.field) appendUrl(p, p.field.start, p.field.url);
          p.field = undefined;
          p.instr = '';
        }
        break;
      }
    }
  }
  return { text: out.join('\n'), links };
}

// ---------------------------------------------------------------------------------------------------------------
// PPTX

/** placeholders that only repeat slide numbers, dates, footers and the slide picture in notes */
const SKIP_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

/** DrawingML text (slides, notes): one line per <a:p>, tables as rows; hyperlinked runs become "text (url)" */
function drawingText(xml: string, rels: Map<string, Rel>, links: string[]): string[] {
  const out: string[] = [];
  const tables = new Tables(out);
  let skipShape = false;
  let para: { text: string; url?: string; start: number } | undefined;
  let inRun = false;
  let runUrl: string | undefined;
  let inT = false;
  const flushLink = () => {
    if (para?.url) appendUrl(para, para.start, para.url);
    if (para) para.url = undefined;
  };

  for (const t of xmlTokens(xml)) {
    if (t.k === 'text') {
      if (!inT || !para) continue;
      if (para.url && para.url !== runUrl) flushLink();
      if (runUrl && !para.url) {
        para.url = runUrl;
        para.start = para.text.length;
      }
      para.text += t.text;
      continue;
    }
    if (tables.tag(t.local, t.k)) continue;
    const on = t.k !== 'close';
    switch (t.local) {
      case 'sp':
        skipShape = false;
        break;
      case 'ph':
        if (on && SKIP_PLACEHOLDERS.has(attr(t.attrs, 'type') ?? '')) skipShape = true;
        break;
      case 'p':
        if (t.k === 'open') para = { text: '', start: 0 };
        else if (t.k === 'close' && para) {
          flushLink();
          const line = para.text.trim();
          if (line && !skipShape) tables.line(line);
          para = undefined;
        }
        break;
      case 'r':
      case 'fld':
        inRun = t.k === 'open';
        runUrl = undefined;
        break;
      case 'hlinkClick':
        if (on) {
          const url = relUrl(rels, relId(t.attrs));
          if (url) {
            links.push(url);
            if (inRun) runUrl = url;
          }
        }
        break;
      case 't':
        inT = t.k === 'open';
        break;
      case 'br':
        if (para && on) para.text += '\n';
        break;
    }
  }
  return out;
}

function extractPptx(files: Map<string, string>, main: string): Parsed {
  const dir = dirOf(main);
  const presRels = parseRels(files.get(relsPathFor(main)));
  const slides: string[] = [];
  for (const t of xmlTokens(files.get(main) ?? '')) {
    if (t.k === 'text' || t.k === 'close' || t.local !== 'sldId') continue;
    const r = presRels.get(relId(t.attrs) ?? '');
    if (r) slides.push(resolvePath(dir, r.target));
  }
  if (!slides.length) {
    const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
    slides.push(...[...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b)));
  }

  const out: string[] = [];
  const links: string[] = [];
  slides.forEach((path, i) => {
    const xml = files.get(path);
    if (xml === undefined) return;
    const relsXml = files.get(relsPathFor(path));
    const rels = parseRels(relsXml);
    const hidden = /<(?:[\w.-]+:)?sld\b[^>]*\sshow\s*=\s*["'](?:0|false)["']/.test(xml);
    out.push(`### Слайд ${i + 1}${hidden ? ' (прихований)' : ''}`, ...drawingText(xml, rels, links));
    const notesPath =
      relTarget(rels, dirOf(path), '/notesSlide') ??
      (relsXml === undefined ? `ppt/notesSlides/notesSlide${/(\d+)\.xml$/.exec(path)?.[1] ?? ''}.xml` : undefined);
    const notesXml = notesPath ? files.get(notesPath) : undefined;
    if (notesXml) {
      const notes = drawingText(notesXml, parseRels(files.get(relsPathFor(notesPath!))), links);
      if (notes.some((l) => l.trim())) out.push(`Нотатки: ${notes.join('\n')}`);
    }
    out.push('');
  });
  return { text: out.join('\n'), links, units: slides.length };
}

// ---------------------------------------------------------------------------------------------------------------
// XLSX

function parseSharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let cur: string | undefined;
  let inT = false;
  let phonetic = 0;
  for (const t of xmlTokens(xml)) {
    if (t.k === 'text') {
      if (cur !== undefined && inT && !phonetic) cur += t.text;
      continue;
    }
    if (t.local === 'si') {
      if (t.k === 'open') cur = '';
      else {
        out.push(cur ?? '');
        cur = undefined;
      }
    } else if (t.local === 't') inT = t.k === 'open';
    else if (t.local === 'rPh') {
      if (t.k === 'open') phonetic++;
      else if (t.k === 'close') phonetic = Math.max(0, phonetic - 1);
    }
  }
  return out;
}

/** built-in number formats that show a date / time */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** indices of cell styles (cellXfs) whose number format is a date */
function parseDateStyles(xml: string | undefined): Set<number> {
  const dates = new Set<number>();
  if (!xml) return dates;
  const custom = new Map<number, string>();
  let inXfs = false;
  let index = 0;
  for (const t of xmlTokens(xml)) {
    if (t.k === 'text') continue;
    if (t.local === 'numFmt' && t.k !== 'close') custom.set(Number(attr(t.attrs, 'numFmtId')), attr(t.attrs, 'formatCode') ?? '');
    else if (t.local === 'cellXfs') inXfs = t.k === 'open';
    else if (t.local === 'xf' && inXfs && t.k !== 'close') {
      const id = Number(attr(t.attrs, 'numFmtId') ?? 0);
      const code = custom.get(id);
      const isDate =
        code === undefined
          ? DATE_FORMAT_IDS.has(id)
          : /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, ''));
      if (isDate) dates.add(index);
      index++;
    }
  }
  return dates;
}

/** an Excel serial day number as 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM' or 'HH:MM' */
function excelDate(serial: number, date1904: boolean): string | undefined {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = base + Math.round(serial * 86400) * 1000;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime()) || serial < 0) return undefined;
  const iso = d.toISOString();
  const time = iso.slice(11, 16);
  if (serial < 1) return time;
  return ms % 86_400_000 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

function colIndex(ref: string): number | undefined {
  const letters = /^\$?([A-Za-z]{1,3})/.exec(ref)?.[1];
  if (!letters) return undefined;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** OOXML escapes control characters as _xHHHH_ */
function unescapeOoxml(s: string): string {
  return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : s;
}

function ukPlural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

interface SheetCtx {
  shared: string[];
  dateStyles: Set<number>;
  date1904: boolean;
  links: string[];
}

function sheetLines(xml: string, rels: Map<string, Rel>, ctx: SheetCtx): string[] {
  // <hyperlinks> come after <sheetData>, so find them first
  const cellLinks = new Map<string, string>();
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?hyperlink\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    const url = relUrl(rels, relId(attrs));
    if (!url) continue;
    ctx.links.push(url);
    const ref = attr(attrs, 'ref')?.split(':')[0]?.replace(/\$/g, '').toUpperCase();
    if (ref && !cellLinks.has(ref)) cellLinks.set(ref, url);
  }

  const rows: Map<number, string>[] = [];
  let extra = 0;
  let minCol = Infinity;
  let maxCol = -1;
  let row: Map<number, string> | undefined;
  let col = -1;
  let cell: XlsxCell | undefined;
  let inV = false;
  let inF = false;
  let inIs = false;
  let inT = false;
  let phonetic = 0;
  const at = { pos: 0 };

  scan: for (const t of xmlTokens(xml, at)) {
    if (t.k === 'text') {
      if (!cell) continue;
      if (inV) cell.v += t.text;
      else if (inF) cell.f += t.text;
      else if (inIs && inT && !phonetic) cell.is += t.text;
      continue;
    }
    switch (t.local) {
      case 'row':
        if (t.k !== 'close' && rows.length >= MAX_SHEET_ROWS) {
          // enough rows: just count the rest, without parsing every cell
          extra = countFilledRows(xml.slice(at.pos));
          break scan;
        }
        if (t.k === 'open') {
          row = new Map();
          col = -1;
        } else if (t.k === 'close' && row) {
          if (row.size) {
            rows.push(row);
            for (const c of row.keys()) {
              minCol = Math.min(minCol, c);
              maxCol = Math.max(maxCol, c);
            }
          }
          row = undefined;
        }
        break;
      case 'c':
        if (t.k === 'close') {
          if (cell && row) {
            const value = cellValue(cell, ctx);
            if (value) {
              const url = cell.ref ? cellLinks.get(cell.ref.replace(/\$/g, '').toUpperCase()) : undefined;
              row.set(cell.col, url && !sameUrl(value, url) ? `${value} (${url})` : value);
            }
          }
          cell = undefined;
        } else {
          const ref = attr(t.attrs, 'r');
          col = (ref ? colIndex(ref) : undefined) ?? col + 1;
          if (t.k === 'open') cell = { col, ref, type: attr(t.attrs, 't') ?? 'n', style: Number(attr(t.attrs, 's') ?? 0), v: '', is: '', f: '' };
        }
        break;
      case 'v':
        inV = t.k === 'open';
        break;
      case 'f':
        inF = t.k === 'open';
        break;
      case 'is':
        inIs = t.k === 'open';
        break;
      case 't':
        inT = t.k === 'open';
        break;
      case 'rPh':
        if (t.k === 'open') phonetic++;
        else if (t.k === 'close') phonetic = Math.max(0, phonetic - 1);
        break;
    }
  }

  if (!rows.length) return ['(порожній аркуш)'];
  const width = Math.min(maxCol - minCol + 1, MAX_SHEET_COLS);
  const lines = rows.map((r) => {
    const cells: string[] = [];
    for (let c = minCol; c < minCol + width; c++) cells.push(r.get(c) ?? '');
    return `| ${cells.join(' | ')} |`;
  });
  if (maxCol - minCol + 1 > MAX_SHEET_COLS) lines.push(`(показано перші ${MAX_SHEET_COLS} стовпців)`);
  if (extra) lines.push(`…ще ${extra} ${ukPlural(extra, 'рядок', 'рядки', 'рядків')}`);
  return lines;
}

/** rows that hold at least one value (a self-closing empty row merges into the next match, which is fine) */
function countFilledRows(xml: string): number {
  let n = 0;
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?row>/g))
    if (/<(?:[\w.-]+:)?[vt][\s>]/.test(m[1] ?? '')) n++;
  return n;
}

interface XlsxCell {
  col: number;
  ref?: string;
  /** t="…": s | str | inlineStr | b | e | d | n */
  type: string;
  /** index into cellXfs */
  style: number;
  v: string;
  is: string;
  /** formula text */
  f: string;
}

function cellValue(c: XlsxCell, ctx: SheetCtx): string {
  let v: string;
  switch (c.type) {
    case 's':
      v = c.v.trim() ? (ctx.shared[Number(c.v)] ?? '') : '';
      break;
    case 'inlineStr':
      v = c.is;
      break;
    case 'b':
      v = c.v === '1' ? 'TRUE' : c.v === '0' ? 'FALSE' : c.v;
      break;
    case 'str':
    case 'e':
    case 'd':
      v = c.v;
      break;
    default: {
      v = c.v || c.is;
      const n = Number(c.v);
      if (c.v && ctx.dateStyles.has(c.style) && Number.isFinite(n)) v = excelDate(n, ctx.date1904) ?? c.v;
    }
  }
  // a formula nobody calculated (files written by scripts): show the formula itself
  if (!v && c.f.trim()) v = `=${c.f.trim()}`;
  return cellText(unescapeOoxml(v));
}

function extractXlsx(files: Map<string, string>, main: string): Parsed {
  const wb = files.get(main);
  if (wb === undefined) throw new UnsupportedFile(CORRUPT);
  const dir = dirOf(main);
  const rels = parseRels(files.get(relsPathFor(main)));
  const sheets: { name: string; path?: string; hidden: boolean }[] = [];
  let date1904 = false;
  for (const t of xmlTokens(wb)) {
    if (t.k === 'text' || t.k === 'close') continue;
    if (t.local === 'sheet') {
      const r = rels.get(relId(t.attrs) ?? '');
      sheets.push({
        name: attr(t.attrs, 'name') ?? `Аркуш ${sheets.length + 1}`,
        path: r ? resolvePath(dir, r.target) : undefined,
        hidden: (attr(t.attrs, 'state') ?? 'visible') !== 'visible',
      });
    } else if (t.local === 'workbookPr') date1904 = /^(1|true)$/i.test(attr(t.attrs, 'date1904') ?? '');
  }

  const ctx: SheetCtx = {
    shared: parseSharedStrings(files.get(relTarget(rels, dir, '/sharedStrings') ?? `${dir}/sharedStrings.xml`)).map(unescapeOoxml),
    dateStyles: parseDateStyles(files.get(relTarget(rels, dir, '/styles') ?? `${dir}/styles.xml`)),
    date1904,
    links: [],
  };
  const out: string[] = [];
  for (const s of sheets) {
    out.push(`### Аркуш «${s.name}»${s.hidden ? ' (прихований)' : ''}`);
    const xml = s.path ? files.get(s.path) : undefined;
    if (xml === undefined || !s.path) out.push('(не вдалося прочитати аркуш)');
    else out.push(...sheetLines(xml, parseRels(files.get(relsPathFor(s.path))), ctx));
    out.push('');
  }
  return { text: out.join('\n'), links: ctx.links, units: sheets.length };
}

// ---------------------------------------------------------------------------------------------------------------
// PDF

/** errors pdf.js raises for the file itself; anything else (a runtime problem) is rethrown as is */
const PDF_FILE_ERRORS = new Set(['InvalidPDFException', 'MissingPDFException', 'FormatError', 'UnknownErrorException']);

function pdfFileError(e: unknown): unknown {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'PasswordException') return new UnsupportedFile('PDF захищено паролем — зніміть пароль і надішліть ще раз');
  if (PDF_FILE_ERRORS.has(name)) return new UnsupportedFile('Не вдалося відкрити PDF — схоже, файл пошкоджений');
  return e;
}

async function extractPdf(data: Uint8Array): Promise<Parsed> {
  // lazy: pdf.js is big and most messages carry no PDF
  const { getDocumentProxy, extractText: pdfText, extractLinks } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // a copy: pdf.js may take ownership of (detach) the buffer it is given
    pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  } catch (e) {
    throw pdfFileError(e);
  }
  try {
    const { totalPages, text } = await pdfText(pdf, { mergePages: false }).catch((e: unknown) => {
      throw pdfFileError(e);
    });
    let links: string[] = [];
    try {
      links = (await extractLinks(pdf)).links;
    } catch {
      // annotations are a bonus
    }
    const pages = text.map((page) => page.replace(/[ \t]+\n/g, '\n').trim()).filter(Boolean);
    return { text: pages.join('\n\n'), links, units: totalPages };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CSV / JSON / HTML

function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
      wasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      wasQuoted = false;
    } else field += ch;
  }
  if (field !== '' || row.length || wasQuoted) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** the most frequent of , ; tab | in the first line */
function guessDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const n = count(first, d);
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

function csvToTable(text: string, delim?: string): string {
  return parseCsv(text, delim ?? guessDelimiter(text))
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => `| ${r.map(cellText).join(' | ')} |`)
    .join('\n');
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const BLOCK_TAGS =
  'p|div|section|article|header|footer|nav|aside|main|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|blockquote|pre|hr|figure|figcaption|form|fieldset|address|details|summary|h[1-6]';

/** crude HTML → text: no script/style, block tags → newlines, links → "text (url)" */
function htmlToText(html: string, links: string[]): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
      const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(` ${attrs}`);
      const url = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
      if (!isHttp(url)) return inner;
      links.push(url);
      const shown = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
      return !shown ? url : sameUrl(shown, url) ? inner : `${inner} (${url})`;
    })
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n## ')
    .replace(/<tr\b[^>]*>/gi, '\n| ')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n');
  const t = title ? decodeEntities(title.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '';
  return t && !s.includes(t) ? `## ${t}\n\n${s}` : s;
}
