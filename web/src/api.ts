export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const UNAUTHORIZED = 'aia:unauthorized';

async function call<T>(method: string, url: string, body?: unknown, raw?: { body: Blob; type: string }): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'aia' };
  let payload: BodyInit | undefined;
  if (raw) {
    headers['content-type'] = raw.type;
    payload = raw.body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
  if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `Помилка ${res.status}`, data);
  return data as T;
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => call<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => call<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => call<T>('PUT', url, body),
  del: <T>(url: string) => call<T>('DELETE', url),
  upload: <T>(url: string, blob: Blob) => call<T>('POST', url, undefined, { body: blob, type: blob.type || 'audio/webm' }),
};
