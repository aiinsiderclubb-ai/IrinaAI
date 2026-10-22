import type { NotionApi } from './client.js';
import { isDuplicateTitle } from './dedupe.js';
import { matchFilter, notEqualFilter, readProp, writeProp } from './props.js';
import type { NotionSchema, PropRef } from './schema.js';

export interface Task {
  id: string;
  title: string;
  project?: string;
  status: string;
  done: boolean;
  /** ISO date or datetime */
  due?: string;
  priority?: string;
  notes?: string;
  url?: string;
  lastEdited?: string;
}

export interface TaskInput {
  title: string;
  project?: string;
  due?: string;
  priority?: string;
  notes?: string;
}

export interface TaskQuery {
  project?: string;
  open?: boolean;
  /** inclusive upper bound on due, `YYYY-MM-DD` */
  dueOnOrBefore?: string;
  dueOn?: string;
  text?: string;
  /** tasks that are done and were edited at/after this ISO time */
  doneSince?: string;
  limit?: number;
}

export interface WaitingItem {
  id: string;
  title: string;
  project?: string;
  from?: string;
  due?: string;
  open: boolean;
}

export interface Decision {
  id: string;
  title: string;
  project?: string;
  owner?: string;
  due?: string;
  text?: string;
  createdAt?: string;
}

export interface FinanceEntry {
  id: string;
  date: string;
  /** signed? no: always positive, direction is in `kind` */
  amount: number;
  currency: string;
  kind: 'expense' | 'income';
  category: string;
  scope: 'personal' | 'project';
  project?: string;
  note: string;
}

export class NotionNotConfigured extends Error {
  constructor(what: string) {
    super(`Notion: не налаштовано ${what}. Запустіть npm run setup:notion`);
  }
}

const MAX_PAGES = 10;

export class NotionRepo {
  private relationNames = new Map<string, { at: number; byId: Map<string, string> }>();

  constructor(
    private api: NotionApi,
    private schema: NotionSchema,
    private now: () => number = Date.now,
  ) {}

  // ---------- generic ----------

  private async queryAll(db: string, body: Record<string, unknown>, max = MAX_PAGES * 100): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES && out.length < max; i++) {
      const res: any = await this.api.request('POST', `/v1/databases/${db}/query`, {
        page_size: 100,
        ...body,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      out.push(...res.results);
      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
    return out.slice(0, max);
  }

  private async relationTitles(db: string): Promise<Map<string, string>> {
    const cached = this.relationNames.get(db);
    if (cached && this.now() - cached.at < 5 * 60_000) return cached.byId;
    const pages = await this.queryAll(db, {});
    const byId = new Map<string, string>();
    for (const p of pages) {
      const titleProp = Object.values(p.properties as Record<string, any>).find((x: any) => x.type === 'title');
      byId.set(p.id, (titleProp?.title ?? []).map((t: any) => t.plain_text).join(''));
    }
    this.relationNames.set(db, { at: this.now(), byId });
    return byId;
  }

  /** Reads a "project" property as one display string. */
  private async projectOf(ref: PropRef | undefined, page: any): Promise<string | undefined> {
    const v = readProp(ref, page);
    if (v === undefined || v === '') return undefined;
    if (ref?.type === 'relation') {
      const ids = v as string[];
      if (!ref.relationDb || ids.length === 0) return undefined;
      const names = await this.relationTitles(ref.relationDb);
      return ids.map((id) => names.get(id) ?? '?').join(', ');
    }
    return Array.isArray(v) ? v.join(', ') : String(v);
  }

  private async projectValue(ref: PropRef, name: string): Promise<unknown> {
    if (ref.type !== 'relation') return ref.type === 'multi_select' ? [name] : name;
    if (!ref.relationDb) throw new NotionNotConfigured(`relationDb для властивості «${ref.name}»`);
    const names = await this.relationTitles(ref.relationDb);
    const wanted = name.trim().toLowerCase();
    const hit = [...names.entries()].find(([, n]) => n.trim().toLowerCase() === wanted);
    if (!hit) throw new Error(`Проєкт «${name}» не знайдено в Notion. Наявні: ${[...names.values()].join(', ')}`);
    return [hit[0]];
  }

  private async projectFilter(ref: PropRef, name: string): Promise<any> {
    if (ref.type === 'relation') {
      const ids = (await this.projectValue(ref, name)) as string[];
      return matchFilter(ref, ids[0]!);
    }
    return matchFilter(ref, name);
  }

  async listProjects(): Promise<string[]> {
    const ref = this.schema.tasks.project;
    if (ref?.type === 'relation' && ref.relationDb) return [...(await this.relationTitles(ref.relationDb)).values()].filter(Boolean);
    if (!ref) return [];
    const meta: any = await this.api.request('GET', `/v1/databases/${this.schema.tasks.db}`);
    const p = meta.properties?.[ref.name];
    return ((p?.select ?? p?.multi_select)?.options ?? []).map((o: any) => o.name);
  }

  // ---------- tasks ----------

  private async toTask(page: any): Promise<Task> {
    const s = this.schema.tasks;
    const status = readProp(s.status, page);
    const done = s.status.type === 'checkbox' ? status === true : status === s.status.done;
    const due = readProp(s.due, page) as { start: string } | undefined;
    const priority = readProp(s.priority, page);
    return {
      id: page.id,
      title: readProp(s.title, page) as string,
      project: await this.projectOf(s.project, page),
      status: s.status.type === 'checkbox' ? (done ? s.status.done : s.status.todo) : String(status ?? s.status.todo),
      done,
      due: due?.start,
      priority: priority === undefined ? undefined : String(priority),
      notes: readProp(s.notes, page) || undefined,
      url: page.url,
      lastEdited: page.last_edited_time,
    };
  }

  async queryTasks(q: TaskQuery = {}): Promise<Task[]> {
    const s = this.schema.tasks;
    const and: any[] = [];
    if (q.open) and.push(notEqualFilter(s.status, s.status.done));
    if (q.doneSince) {
      and.push(s.status.type === 'checkbox' ? { property: s.status.name, checkbox: { equals: true } } : matchFilter(s.status, s.status.done));
      and.push({ timestamp: 'last_edited_time', last_edited_time: { on_or_after: q.doneSince } });
    }
    if (q.project && s.project) and.push(await this.projectFilter(s.project, q.project));
    if (q.dueOnOrBefore && s.due) and.push({ property: s.due.name, date: { on_or_before: q.dueOnOrBefore } });
    if (q.dueOn && s.due) and.push({ property: s.due.name, date: { equals: q.dueOn } });
    if (q.text) and.push({ property: s.title.name, title: { contains: q.text } });
    const pages = await this.queryAll(s.db, { ...(and.length ? { filter: { and } } : {}) }, q.limit ?? 200);
    return Promise.all(pages.map((p) => this.toTask(p)));
  }

  async getTask(id: string): Promise<Task> {
    return this.toTask(await this.api.request('GET', `/v1/pages/${id}`));
  }

  /** Open task in the same project that looks like the same one. */
  async findDuplicate(title: string, project?: string): Promise<Task | undefined> {
    const open = await this.queryTasks({ open: true, project, limit: 300 });
    return open.find((t) => isDuplicateTitle(t.title, title));
  }

  private async taskProps(input: Partial<TaskInput>): Promise<Record<string, any>> {
    const s = this.schema.tasks;
    const props: Record<string, any> = {};
    if (input.title !== undefined) props[s.title.name] = writeProp(s.title, input.title);
    if (input.project && s.project) props[s.project.name] = writeProp(s.project, await this.projectValue(s.project, input.project));
    if (input.due !== undefined && s.due) props[s.due.name] = writeProp(s.due, input.due);
    if (input.priority && s.priority) props[s.priority.name] = writeProp(s.priority, input.priority);
    if (input.notes && s.notes) props[s.notes.name] = writeProp(s.notes, input.notes);
    return props;
  }

  async createTask(input: TaskInput): Promise<Task> {
    const s = this.schema.tasks;
    const props = await this.taskProps(input);
    props[s.status.name] = writeProp(s.status, s.status.type === 'checkbox' ? false : s.status.todo);
    const children =
      input.notes && !s.notes ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: input.notes.slice(0, 1900) } }] } }] : undefined;
    const page = await this.api.request('POST', '/v1/pages', { parent: { database_id: s.db }, properties: props, ...(children ? { children } : {}) });
    return this.toTask(page);
  }

  async updateTask(id: string, patch: Partial<TaskInput>): Promise<Task> {
    return this.toTask(await this.api.request('PATCH', `/v1/pages/${id}`, { properties: await this.taskProps(patch) }));
  }

  async setTaskStatus(id: string, which: 'todo' | 'doing' | 'done'): Promise<Task> {
    const s = this.schema.tasks;
    const value = which === 'doing' ? (s.status.doing ?? s.status.todo) : s.status[which];
    const prop = writeProp(s.status, s.status.type === 'checkbox' ? which === 'done' : value);
    return this.toTask(await this.api.request('PATCH', `/v1/pages/${id}`, { properties: { [s.status.name]: prop } }));
  }

  // ---------- decisions & agreements ----------

  async logDecision(d: { title: string; project?: string; owner?: string; due?: string; text?: string }): Promise<Decision> {
    const s = this.schema.decisions;
    if (!s) throw new NotionNotConfigured('база «Рішення»');
    const props: Record<string, any> = { [s.title.name]: writeProp(s.title, d.title) };
    if (d.project && s.project) props[s.project.name] = writeProp(s.project, await this.projectValue(s.project, d.project));
    if (d.owner && s.owner) props[s.owner.name] = writeProp(s.owner, d.owner);
    if (d.due && s.due) props[s.due.name] = writeProp(s.due, d.due);
    if (d.text && s.text) props[s.text.name] = writeProp(s.text, d.text);
    const page = await this.api.request('POST', '/v1/pages', { parent: { database_id: s.db }, properties: props });
    return this.toDecision(page);
  }

  private async toDecision(page: any): Promise<Decision> {
    const s = this.schema.decisions!;
    return {
      id: page.id,
      title: readProp(s.title, page),
      project: await this.projectOf(s.project, page),
      owner: readProp(s.owner, page) || undefined,
      due: readProp(s.due, page)?.start,
      text: readProp(s.text, page) || undefined,
      createdAt: page.created_time,
    };
  }

  async listDecisionsSince(iso: string): Promise<Decision[]> {
    const s = this.schema.decisions;
    if (!s) return [];
    const pages = await this.queryAll(s.db, { filter: { timestamp: 'created_time', created_time: { on_or_after: iso } } }, 100);
    return Promise.all(pages.map((p) => this.toDecision(p)));
  }

  // ---------- expected replies ----------

  async addWaiting(w: { title: string; project?: string; from?: string; due?: string }): Promise<WaitingItem> {
    const s = this.schema.waiting;
    if (!s) throw new NotionNotConfigured('база «Очікую відповідь»');
    const props: Record<string, any> = {
      [s.title.name]: writeProp(s.title, w.title),
      [s.status.name]: writeProp(s.status, s.status.open),
    };
    if (w.project && s.project) props[s.project.name] = writeProp(s.project, await this.projectValue(s.project, w.project));
    if (w.from && s.from) props[s.from.name] = writeProp(s.from, w.from);
    if (w.due && s.due) props[s.due.name] = writeProp(s.due, w.due);
    return this.toWaiting(await this.api.request('POST', '/v1/pages', { parent: { database_id: s.db }, properties: props }));
  }

  private async toWaiting(page: any): Promise<WaitingItem> {
    const s = this.schema.waiting!;
    return {
      id: page.id,
      title: readProp(s.title, page),
      project: await this.projectOf(s.project, page),
      from: readProp(s.from, page) || undefined,
      due: readProp(s.due, page)?.start,
      open: readProp(s.status, page) === s.status.open,
    };
  }

  async listWaiting(): Promise<WaitingItem[]> {
    const s = this.schema.waiting;
    if (!s) return [];
    const pages = await this.queryAll(s.db, { filter: matchFilter(s.status, s.status.open) }, 100);
    return Promise.all(pages.map((p) => this.toWaiting(p)));
  }

  async resolveWaiting(id: string): Promise<void> {
    const s = this.schema.waiting;
    if (!s) throw new NotionNotConfigured('база «Очікую відповідь»');
    await this.api.request('PATCH', `/v1/pages/${id}`, { properties: { [s.status.name]: writeProp(s.status, s.status.done) } });
  }

  // ---------- finance ----------

  async addFinance(e: Omit<FinanceEntry, 'id'>): Promise<FinanceEntry> {
    const s = this.schema.finance;
    if (!s) throw new NotionNotConfigured('база «Фінанси»');
    const props: Record<string, any> = {
      [s.title.name]: writeProp(s.title, e.note || e.category),
      [s.date.name]: writeProp(s.date, e.date),
      [s.amount.name]: writeProp(s.amount, e.amount),
      [s.currency.name]: writeProp(s.currency, e.currency),
      [s.kind.name]: writeProp(s.kind, e.kind === 'expense' ? s.kind.expense : s.kind.income),
      [s.category.name]: writeProp(s.category, e.category),
      [s.scope.name]: writeProp(s.scope, e.scope === 'personal' ? s.scope.personal : s.scope.project),
    };
    if (e.project && s.project) props[s.project.name] = writeProp(s.project, await this.projectValue(s.project, e.project));
    const page = await this.api.request('POST', '/v1/pages', { parent: { database_id: s.db }, properties: props });
    return { ...e, id: page.id };
  }

  async queryFinance(from: string, to: string): Promise<FinanceEntry[]> {
    const s = this.schema.finance;
    if (!s) throw new NotionNotConfigured('база «Фінанси»');
    const pages = await this.queryAll(s.db, {
      filter: { and: [{ property: s.date.name, date: { on_or_after: from } }, { property: s.date.name, date: { on_or_before: to } }] },
    }, 5000);
    const out: FinanceEntry[] = [];
    for (const p of pages) {
      const amount = readProp(s.amount, p);
      if (typeof amount !== 'number') continue;
      out.push({
        id: p.id,
        date: readProp(s.date, p)?.start?.slice(0, 10) ?? from,
        amount,
        currency: String(readProp(s.currency, p) ?? ''),
        kind: readProp(s.kind, p) === s.kind.income ? 'income' : 'expense',
        category: String(readProp(s.category, p) ?? ''),
        scope: readProp(s.scope, p) === s.scope.personal ? 'personal' : 'project',
        project: await this.projectOf(s.project, p),
        note: String(readProp(s.title, p) ?? ''),
      });
    }
    return out;
  }

  // ---------- materials (ChatGPT / Dot imports) ----------

  async saveNote(n: {
    title: string;
    project?: string;
    source?: string;
    date?: string;
    text: string;
    file?: { data: Uint8Array; name: string; mime: string };
  }): Promise<{ id: string; url?: string; fileAttached: boolean; fileError?: string }> {
    const s = this.schema.notes;
    if (!s) throw new NotionNotConfigured('база «Матеріали»');
    const props: Record<string, any> = { [s.title.name]: writeProp(s.title, n.title.slice(0, 200)) };
    if (n.project && s.project) props[s.project.name] = writeProp(s.project, await this.projectValue(s.project, n.project));
    if (n.source && s.source) props[s.source.name] = writeProp(s.source, n.source);
    if (n.date && s.date) props[s.date.name] = writeProp(s.date, n.date);
    const paragraphs = n.text
      .split(/\n{2,}/)
      .flatMap((p) => p.match(/[\s\S]{1,1900}/g) ?? [])
      .slice(0, 90)
      .map((c) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: c } }] } }));
    const page = await this.api.request('POST', '/v1/pages', { parent: { database_id: s.db }, properties: props, children: paragraphs });
    let fileAttached = false;
    let fileError: string | undefined;
    if (n.file) {
      try {
        const uploadId = await this.api.upload(n.file.data, n.file.name, n.file.mime);
        const type = n.file.mime.startsWith('image/') ? 'image' : 'file';
        await this.api.request('PATCH', `/v1/blocks/${page.id}/children`, {
          children: [{ object: 'block', type, [type]: { type: 'file_upload', file_upload: { id: uploadId } } }],
        });
        fileAttached = true;
      } catch (e) {
        fileError = e instanceof Error ? e.message : String(e);
      }
    }
    return { id: page.id, url: page.url, fileAttached, fileError };
  }
}
