export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON-serialised */
  json?: unknown;
  /** x-www-form-urlencoded */
  form?: Record<string, string>;
  body?: string | FormData | Uint8Array | ArrayBuffer;
  query?: Record<string, string | number | undefined>;
  retries?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | FormData | Uint8Array | ArrayBuffer | undefined = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(u, {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (res.ok) return res;
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw new HttpError(res.status, u.origin + u.pathname, text);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt >= retries) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await http(url, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
