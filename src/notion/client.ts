import { HttpError, http, httpJson } from '../lib/http.js';

export interface NotionApi {
  request<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** Notion file-upload API: returns the file_upload id to attach to a block. */
  upload(data: Uint8Array, filename: string, mime: string): Promise<string>;
}

const BASE = 'https://api.notion.com';

export class NotionHttp implements NotionApi {
  constructor(
    private token: string,
    private version = '2022-06-28',
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'notion-version': this.version };
  }

  request<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return httpJson<T>(`${BASE}${path}`, { method, headers: this.headers(), json: body });
  }

  async upload(data: Uint8Array, filename: string, mime: string): Promise<string> {
    const created = await this.request<{ id: string; upload_url: string }>('POST', '/v1/file_uploads', {
      filename,
      content_type: mime,
    });
    const form = new FormData();
    form.append('file', new Blob([data as unknown as ArrayBuffer], { type: mime }), filename);
    const res = await http(created.upload_url, { method: 'POST', headers: this.headers(), body: form });
    if (!res.ok) throw new HttpError(res.status, created.upload_url, await res.text());
    return created.id;
  }
}
