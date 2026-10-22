import type { NotionApi } from '../../src/notion/client.js';
import type { NotionSchema } from '../../src/notion/schema.js';

/** Tiny in-memory Notion: pages in databases, the filter subset the repo uses, write->read property conversion. */
export class FakeNotion implements NotionApi {
  pages = new Map<string, any>();
  dbOf = new Map<string, string>();
  uploads: string[] = [];
  private n = 0;
  constructor(private now: () => Date = () => new Date()) {}

  private readProps(props: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(props)) {
      const conv = (arr: any[]) => arr.map((t) => ({ plain_text: t.text?.content ?? '' }));
      if ('title' in v) out[k] = { type: 'title', title: conv(v.title) };
      else if ('rich_text' in v) out[k] = { type: 'rich_text', rich_text: conv(v.rich_text) };
      else if ('select' in v) out[k] = { type: 'select', select: v.select };
      else if ('status' in v) out[k] = { type: 'status', status: v.status };
      else if ('multi_select' in v) out[k] = { type: 'multi_select', multi_select: v.multi_select };
      else if ('date' in v) out[k] = { type: 'date', date: v.date };
      else if ('number' in v) out[k] = { type: 'number', number: v.number };
      else if ('checkbox' in v) out[k] = { type: 'checkbox', checkbox: v.checkbox };
      else if ('relation' in v) out[k] = { type: 'relation', relation: v.relation };
      else out[k] = v;
    }
    return out;
  }

  /** seed a page directly (e.g. a project page for a relation DB) */
  seed(db: string, props: Record<string, any>, extra: Partial<{ created: string; edited: string }> = {}): string {
    const id = `page-${++this.n}`;
    const t = extra.created ?? this.now().toISOString();
    this.pages.set(id, { id, object: 'page', url: `https://notion.so/${id}`, created_time: t, last_edited_time: extra.edited ?? t, properties: this.readProps(props) });
    this.dbOf.set(id, db);
    return id;
  }

  private matches(page: any, f: any): boolean {
    if (!f) return true;
    if (f.and) return f.and.every((x: any) => this.matches(page, x));
    if (f.or) return f.or.some((x: any) => this.matches(page, x));
    if (f.timestamp) {
      const cond = f[f.timestamp];
      const t = page[f.timestamp];
      return cond.on_or_after ? t >= cond.on_or_after : true;
    }
    const prop = page.properties[f.property];
    if (!prop) return false;
    if (f.status) {
      const v = prop.status?.name;
      return f.status.equals !== undefined ? v === f.status.equals : v !== f.status.does_not_equal;
    }
    if (f.select) {
      const v = prop.select?.name;
      return f.select.equals !== undefined ? v === f.select.equals : v !== f.select.does_not_equal;
    }
    if (f.checkbox) return Boolean(prop.checkbox) === f.checkbox.equals;
    if (f.multi_select) return (prop.multi_select ?? []).some((o: any) => o.name === f.multi_select.contains);
    if (f.rich_text) return prop.rich_text.map((t: any) => t.plain_text).join('').includes(f.rich_text.contains);
    if (f.title) return prop.title.map((t: any) => t.plain_text).join('').toLowerCase().includes(f.title.contains.toLowerCase());
    if (f.relation) return (prop.relation ?? []).some((r: any) => r.id === f.relation.contains);
    if (f.date) {
      const start: string | undefined = prop.date?.start;
      if (!start) return false;
      const c = f.date;
      if (c.equals) return start.slice(0, 10) === c.equals;
      if (c.on_or_before) return start.slice(0, 10) <= c.on_or_before;
      if (c.on_or_after) return start.slice(0, 10) >= c.on_or_after;
    }
    return false;
  }

  async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/v1\/databases\/([^/]+)\/query$/))) {
      const results = [...this.pages.values()].filter((p) => this.dbOf.get(p.id) === m![1] && this.matches(p, body?.filter));
      return { results, has_more: false } as T;
    }
    if (method === 'POST' && path === '/v1/pages') {
      const id = this.seed(body.parent.database_id, body.properties);
      return this.pages.get(id) as T;
    }
    if ((m = path.match(/^\/v1\/pages\/([^/]+)$/))) {
      const page = this.pages.get(m[1]!);
      if (!page) throw new Error(`no page ${m[1]}`);
      if (method === 'PATCH') {
        Object.assign(page.properties, this.readProps(body.properties));
        page.last_edited_time = this.now().toISOString();
      }
      return page as T;
    }
    if ((m = path.match(/^\/v1\/blocks\/([^/]+)\/children$/))) {
      const page = this.pages.get(m[1]!);
      (page.children ??= []).push(...body.children);
      return {} as T;
    }
    throw new Error(`FakeNotion: unsupported ${method} ${path}`);
  }

  async upload(_data: Uint8Array, filename: string): Promise<string> {
    this.uploads.push(filename);
    return `upload-${this.uploads.length}`;
  }

  /** titles of the pages in a DB */
  titles(db: string, titleProp = 'Name'): string[] {
    return [...this.pages.values()].filter((p) => this.dbOf.get(p.id) === db).map((p) => p.properties[titleProp].title.map((t: any) => t.plain_text).join(''));
  }
}

export const TEST_SCHEMA: NotionSchema = {
  tasks: {
    db: 'tasks',
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    status: { name: 'Status', type: 'status', todo: 'Not started', doing: 'In progress', done: 'Done' },
    due: { name: 'Due', type: 'date' },
    priority: { name: 'Priority', type: 'select' },
    notes: { name: 'Notes', type: 'rich_text' },
  },
  decisions: {
    db: 'decisions',
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    owner: { name: 'Owner', type: 'rich_text' },
    due: { name: 'Due', type: 'date' },
    text: { name: 'Details', type: 'rich_text' },
  },
  waiting: {
    db: 'waiting',
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    from: { name: 'From', type: 'rich_text' },
    due: { name: 'Due', type: 'date' },
    status: { name: 'Status', type: 'select', open: 'Очікую', done: 'Отримано' },
  },
  finance: {
    db: 'finance',
    title: { name: 'Note', type: 'title' },
    date: { name: 'Date', type: 'date' },
    amount: { name: 'Amount', type: 'number' },
    currency: { name: 'Currency', type: 'select' },
    kind: { name: 'Kind', type: 'select', expense: 'Витрата', income: 'Дохід' },
    category: { name: 'Category', type: 'select' },
    scope: { name: 'Scope', type: 'select', personal: 'Особисте', project: 'Проєкт' },
    project: { name: 'Project', type: 'select' },
  },
  notes: {
    db: 'notes',
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    source: { name: 'Source', type: 'select' },
    date: { name: 'Date', type: 'date' },
  },
};
