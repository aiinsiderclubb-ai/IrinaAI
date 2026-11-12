import { HttpError } from '../../src/lib/http.js';

const rt = (t: string, href?: string) => ({ type: 'text', plain_text: t, href: href ?? null, text: { content: t, link: href ? { url: href } : null } });
export const block = (id: string, type: string, text = '', extra: Record<string, unknown> = {}, hasChildren = false) => ({
  id,
  type,
  has_children: hasChildren,
  [type]: { rich_text: text ? [rt(text)] : [], ...extra },
});
export const linkText = (t: string, href: string) => [rt(t, href)];

interface Db {
  title: string;
  parent: string;
  properties: Record<string, any>;
  rows: Array<{ id: string; properties: Record<string, any> }>;
}

/**
 * A Notion workspace in memory for the reader, project sync and tables:
 * pages, block trees (paginated), databases with rows, search, and the write calls tables use.
 */
export class FakeNotionTree {
  pages = new Map<string, { title: string; parent?: { type: string; database_id?: string; page_id?: string }; lastEdited: string; properties?: Record<string, any> }>();
  blocks = new Map<string, any[]>();
  dbs = new Map<string, Db>();
  /** ids that answer 404 (not shared with the integration) */
  hidden = new Set<string>();
  calls: string[] = [];
  private n = 0;

  page(id: string, title: string, children: any[] = [], lastEdited = '2026-11-01T10:00:00.000Z'): this {
    this.pages.set(id, { title, lastEdited, parent: { type: 'workspace' } });
    this.blocks.set(id, children);
    return this;
  }

  touch(id: string, at: string): void {
    const p = this.pages.get(id);
    if (p) p.lastEdited = at;
  }

  private notFound(path: string): never {
    throw new HttpError(404, `https://api.notion.com${path}`, '{"object":"error","status":404,"code":"object_not_found","message":"Could not find page"}');
  }

  private pageObject(id: string) {
    const p = this.pages.get(id)!;
    return {
      object: 'page',
      id,
      url: `https://www.notion.so/${id.replace(/-/g, '')}`,
      last_edited_time: p.lastEdited,
      parent: p.parent,
      properties: { ...(p.properties ?? {}), Name: { type: 'title', title: [rt(p.title)] } },
    };
  }

  async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    this.calls.push(`${method} ${path}`);
    const [p, qs] = path.split('?');
    const params = new URLSearchParams(qs ?? '');
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = p!.match(/^\/v1\/pages\/([^/]+)$/))) {
      const id = m[1]!;
      if (this.hidden.has(id) || !this.pages.has(id)) this.notFound(path);
      return this.pageObject(id) as T;
    }
    if (method === 'GET' && (m = p!.match(/^\/v1\/blocks\/([^/]+)\/children$/))) {
      const id = m[1]!;
      if (this.hidden.has(id)) this.notFound(path);
      const all = this.blocks.get(id) ?? [];
      const size = Number(params.get('page_size') ?? 100);
      const start = Number(params.get('start_cursor') ?? 0);
      const results = all.slice(start, start + size);
      const more = start + size < all.length;
      return { results, has_more: more, next_cursor: more ? String(start + size) : null } as T;
    }
    if (method === 'GET' && (m = p!.match(/^\/v1\/databases\/([^/]+)$/))) {
      const db = this.dbs.get(m[1]!);
      if (!db || this.hidden.has(m[1]!)) this.notFound(path);
      return { object: 'database', id: m[1], url: `https://www.notion.so/${m[1]}`, title: [rt(db.title)], properties: db.properties, last_edited_time: '2026-11-01T10:00:00.000Z' } as T;
    }
    if (method === 'POST' && (m = p!.match(/^\/v1\/databases\/([^/]+)\/query$/))) {
      const db = this.dbs.get(m[1]!);
      if (!db) this.notFound(path);
      return { results: db.rows.map((r) => ({ id: r.id, url: `https://www.notion.so/${r.id}`, properties: r.properties })), has_more: false } as T;
    }
    if (method === 'POST' && p === '/v1/databases') {
      const id = `db-${++this.n}`;
      const properties = Object.fromEntries(Object.entries<any>(body.properties).map(([k, v]) => [k, { type: Object.keys(v)[0], ...v }]));
      this.dbs.set(id, { title: body.title[0].text.content, parent: body.parent.page_id, properties, rows: [] });
      this.blocks.get(body.parent.page_id)?.push({ id, type: 'child_database', has_children: false, child_database: { title: body.title[0].text.content } });
      return { id, url: `https://www.notion.so/${id}` } as T;
    }
    if (method === 'PATCH' && (m = p!.match(/^\/v1\/databases\/([^/]+)$/))) {
      const db = this.dbs.get(m[1]!)!;
      for (const [k, v] of Object.entries<any>(body.properties)) db.properties[k] = { type: Object.keys(v)[0], ...v };
      return {} as T;
    }
    if (method === 'POST' && p === '/v1/pages' && body.parent?.database_id) {
      const db = this.dbs.get(body.parent.database_id)!;
      const id = `row-${++this.n}`;
      db.rows.push({ id, properties: this.toRead(db, body.properties) });
      return { id } as T;
    }
    if (method === 'PATCH' && (m = p!.match(/^\/v1\/pages\/([^/]+)$/))) {
      for (const db of this.dbs.values()) {
        const row = db.rows.find((r) => r.id === m![1]);
        if (row) Object.assign(row.properties, this.toRead(db, body.properties));
      }
      return {} as T;
    }
    if (method === 'POST' && p === '/v1/search') {
      const q = String(body.query ?? '').toLowerCase();
      const pages = [...this.pages.entries()].filter(([id, x]) => !this.hidden.has(id) && x.title.toLowerCase().includes(q)).map(([id]) => this.pageObject(id));
      const dbs = [...this.dbs.entries()].filter(([, d]) => d.title.toLowerCase().includes(q)).map(([id, d]) => ({ object: 'database', id, title: [rt(d.title)] }));
      return { results: [...pages, ...dbs] } as T;
    }
    throw new Error(`fake notion: ${method} ${path}`);
  }

  /** a written property value as Notion would return it on read */
  private toRead(db: Db, props: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(props)) {
      const type = Object.keys(v)[0]!;
      const val = v[type];
      if (type === 'title' || type === 'rich_text') out[k] = { type, [type]: val.map((x: any) => rt(x.text.content)) };
      else out[k] = { type, [type]: val };
      void db;
    }
    return out;
  }

  async upload(): Promise<string> {
    return 'upload-1';
  }
}
