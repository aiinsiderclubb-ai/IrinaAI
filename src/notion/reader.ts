import { HttpError } from '../lib/http.js';
import type { NotionApi } from './client.js';

/**
 * Reads anything the integration can see in Notion as plain text: a page with its whole block tree
 * (toggles, columns, tables, synced blocks, nested lists) or a database as a table.
 * Read-only by design: only GET requests and database queries.
 */

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX32_END = /([0-9a-f]{32})$/i;

const dashed = (hex: string) => {
  const h = hex.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Page or database id from a Notion link (notion.so, notion.site, peek view ?p=) or a bare id; undefined if there is none. */
export function parseNotionId(input: string): string | undefined {
  const raw = input.trim();
  if (UUID.test(raw)) return dashed(raw);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (!/(^|\.)notion\.(so|site)$/i.test(url.hostname)) return undefined;
  // a page opened as a side peek: notion.so/<db>?v=<view>&p=<page>
  const peek = url.searchParams.get('p');
  if (peek && /^[0-9a-f]{32}$/i.test(peek)) return dashed(peek);
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const m = last.match(HEX32_END) ?? last.replace(/-/g, '').match(HEX32_END);
  if (m) return dashed(m[1]!);
  const uuid = last.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuid ? dashed(uuid[1]!) : undefined;
}

/** Every Notion link in a message (to tell a project link from a plain URL). */
export function findNotionLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')]*notion\.(?:so|site)\/[^\s<>"')]+/gi)].map((m) => m[0]);
}

export interface NotionRef {
  id: string;
  title: string;
}

export interface NotionFile {
  name: string;
  url: string;
  /** 'file' (uploaded to Notion, the url expires in an hour) or 'external' */
  hosted: 'file' | 'external';
  blockId: string;
}

export interface NotionDoc {
  id: string;
  kind: 'page' | 'database';
  title: string;
  url?: string;
  lastEdited?: string;
  /** the page's own content as Markdown-ish text; sub-pages are listed, not inlined */
  text: string;
  childPages: NotionRef[];
  childDatabases: NotionRef[];
  /** pages referenced by «link to page» blocks and @-mentions */
  linkedPages: string[];
  /** external http(s) links: bookmarks, embeds, links inside the text */
  links: string[];
  files: NotionFile[];
  /** the block limit was hit: the rest of the page was not read */
  cut?: boolean;
}

/** Notion says the page does not exist or is not shared with the integration. */
export class NotionAccessError extends Error {}

export const ACCESS_HINT =
  'Notion не дає доступу до цієї сторінки. Відкрийте її в Notion → «•••» вгорі праворуч → «Connections / Підключення» → додайте інтеграцію асистента. ' +
  'Достатньо зробити це на верхній сторінці проєкту: усі вкладені сторінки отримають доступ автоматично.';

const plain = (rich: any[] | undefined) => (rich ?? []).map((t) => t.plain_text ?? '').join('');

function isNotionUrl(u: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*notion\.(so|site)\//i.test(u) || u.startsWith('/');
}

/** Rich text with external links kept inline as «text (url)». */
function richText(rich: any[] | undefined, w: Walk): string {
  let out = '';
  for (const t of rich ?? []) {
    const text: string = t.plain_text ?? '';
    const href: string | undefined = t.href ?? t.text?.link?.url;
    if (t.type === 'mention' && t.mention?.type === 'page' && t.mention.page?.id) w.linkedPages.add(t.mention.page.id);
    if (t.type === 'mention' && t.mention?.type === 'database' && t.mention.database?.id) w.linkedPages.add(t.mention.database.id);
    if (href && !isNotionUrl(href)) {
      w.links.add(href);
      out += text && text !== href ? `${text} (${href})` : href;
    } else out += text;
  }
  return out;
}

interface Walk {
  lines: string[];
  childPages: NotionRef[];
  childDatabases: NotionRef[];
  linkedPages: Set<string>;
  links: Set<string>;
  files: NotionFile[];
  blocks: number;
  maxBlocks: number;
  cut: boolean;
}

async function children(api: NotionApi, id: string, maxPages = 30): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res: any = await api.request('GET', `/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...(res.results ?? []));
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

function fileOf(b: any): { name: string; url: string; hosted: 'file' | 'external' } | undefined {
  const v = b[b.type];
  if (!v) return undefined;
  const url: string | undefined = v.type === 'external' ? v.external?.url : v.type === 'file' ? v.file?.url : undefined;
  if (!url) return undefined;
  const caption = plain(v.caption);
  let name: string = v.name || caption;
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || b.type;
    } catch {
      name = b.type;
    }
  }
  return { name, url, hosted: v.type === 'external' ? 'external' : 'file' };
}

async function walk(api: NotionApi, id: string, indent: string, depth: number, w: Walk): Promise<void> {
  if (depth > 8 || w.cut) return;
  let number = 0;
  for (const b of await children(api, id)) {
    if (++w.blocks > w.maxBlocks) {
      w.cut = true;
      w.lines.push('…(сторінка дуже довга — далі не прочитано)');
      return;
    }
    const v = b[b.type] ?? {};
    const text = richText(v.rich_text, w);
    number = b.type === 'numbered_list_item' ? number + 1 : 0;
    let descend = b.has_children;
    switch (b.type) {
      case 'heading_1':
        w.lines.push('', `## ${text}`);
        break;
      case 'heading_2':
        w.lines.push('', `### ${text}`);
        break;
      case 'heading_3':
        w.lines.push('', `#### ${text}`);
        break;
      case 'bulleted_list_item':
        w.lines.push(`${indent}- ${text}`);
        break;
      case 'numbered_list_item':
        w.lines.push(`${indent}${number}. ${text}`);
        break;
      case 'to_do':
        w.lines.push(`${indent}- [${v.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'toggle':
        w.lines.push(`${indent}▸ ${text}`);
        break;
      case 'quote':
        w.lines.push(`${indent}> ${text}`);
        break;
      case 'callout': {
        const icon = v.icon?.type === 'emoji' ? `${v.icon.emoji} ` : '';
        w.lines.push(`${indent}${icon}${text}`);
        break;
      }
      case 'code':
        w.lines.push('```' + (v.language ?? ''), plain(v.rich_text), '```');
        break;
      case 'equation':
        w.lines.push(`${indent}${v.expression ?? ''}`);
        break;
      case 'divider':
        w.lines.push('---');
        break;
      case 'table': {
        const rows = await children(api, b.id);
        rows.forEach((r, i) => {
          const cells: any[][] = r.table_row?.cells ?? [];
          w.lines.push(`| ${cells.map((c) => richText(c, w).replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`);
          if (i === 0 && v.has_column_header) w.lines.push(`|${cells.map(() => ' --- ').join('|')}|`);
        });
        w.blocks += rows.length;
        descend = false;
        break;
      }
      case 'column_list':
      case 'column':
        // columns are layout only: read their content in place
        await walk(api, b.id, indent, depth + 1, w);
        descend = false;
        break;
      case 'synced_block':
        await walk(api, v.synced_from?.block_id ?? b.id, indent, depth + 1, w);
        descend = false;
        break;
      case 'child_page':
        w.childPages.push({ id: b.id, title: v.title ?? '' });
        w.lines.push(`${indent}📄 Підсторінка «${v.title ?? ''}»`);
        descend = false;
        break;
      case 'child_database':
        w.childDatabases.push({ id: b.id, title: v.title ?? '' });
        w.lines.push(`${indent}🗂 Таблиця «${v.title ?? ''}»`);
        descend = false;
        break;
      case 'link_to_page': {
        const target = v.page_id ?? v.database_id;
        if (target) w.linkedPages.add(target);
        w.lines.push(`${indent}↪ Посилання на іншу сторінку Notion`);
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview': {
        const url: string | undefined = v.url;
        if (url && !isNotionUrl(url)) w.links.add(url);
        const caption = plain(v.caption);
        if (url) w.lines.push(`${indent}🔗 ${caption ? `${caption}: ` : ''}${url}`);
        break;
      }
      case 'image':
      case 'file':
      case 'pdf':
      case 'video':
      case 'audio': {
        const f = fileOf(b);
        if (f) {
          if (b.type !== 'image' && b.type !== 'video' && b.type !== 'audio') w.files.push({ ...f, blockId: b.id });
          w.lines.push(`${indent}📎 ${b.type === 'image' ? 'Зображення' : 'Файл'}: ${f.name}`);
        }
        break;
      }
      case 'table_of_contents':
      case 'breadcrumb':
      case 'unsupported':
      case 'template':
        break;
      default:
        if (text.trim()) w.lines.push(`${indent}${text}`);
    }
    if (descend && b.has_children) await walk(api, b.id, `${indent}  `, depth + 1, w);
  }
}

/** A database property value as short text. */
export function propText(p: any): string {
  if (!p) return '';
  switch (p.type) {
    case 'title':
    case 'rich_text':
      return plain(p[p.type]);
    case 'number':
      return p.number == null ? '' : String(p.number);
    case 'select':
    case 'status':
      return p[p.type]?.name ?? '';
    case 'multi_select':
      return (p.multi_select ?? []).map((o: any) => o.name).join(', ');
    case 'date':
      return p.date ? [p.date.start, p.date.end].filter(Boolean).join(' → ') : '';
    case 'checkbox':
      return p.checkbox ? '✓' : '';
    case 'url':
    case 'email':
    case 'phone_number':
      return p[p.type] ?? '';
    case 'people':
      return (p.people ?? []).map((u: any) => u.name ?? '').filter(Boolean).join(', ');
    case 'files':
      return (p.files ?? []).map((f: any) => f.name ?? '').join(', ');
    case 'formula': {
      const f = p.formula ?? {};
      return String(f[f.type] ?? '');
    }
    case 'rollup': {
      const r = p.rollup ?? {};
      if (r.type === 'array') return (r.array ?? []).map(propText).filter(Boolean).join(', ');
      return String(r[r.type] ?? '');
    }
    case 'relation':
      return (p.relation ?? []).length ? `${p.relation.length} зв’яз.` : '';
    case 'unique_id':
      return p.unique_id ? `${p.unique_id.prefix ? `${p.unique_id.prefix}-` : ''}${p.unique_id.number}` : '';
    case 'created_time':
    case 'last_edited_time':
      return String(p[p.type] ?? '').slice(0, 10);
    default:
      return '';
  }
}

export function pageTitle(page: any): string {
  const t = Object.values<any>(page?.properties ?? {}).find((p) => p?.type === 'title');
  return plain(t?.title).trim() || 'Без назви';
}

function accessError(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 404 || e.status === 403 || (e.status === 400 && /validation|invalid|uuid/i.test(e.body)));
}

export interface DatabaseRow {
  id: string;
  url?: string;
  values: Record<string, string>;
}

export interface DatabaseView {
  id: string;
  title: string;
  url?: string;
  lastEdited?: string;
  /** property name → type, the title column first */
  columns: Array<{ name: string; type: string; options?: string[] }>;
  rows: DatabaseRow[];
  more: boolean;
}

/** A database: its columns and up to `maxRows` rows. */
export async function readDatabase(api: NotionApi, id: string, maxRows = 500): Promise<DatabaseView> {
  const db: any = await api.request('GET', `/v1/databases/${id}`);
  const props = Object.entries<any>(db.properties ?? {});
  props.sort(([, a], [, b]) => (a.type === 'title' ? -1 : b.type === 'title' ? 1 : 0));
  const columns = props.map(([name, p]) => ({
    name,
    type: p.type as string,
    ...(p.type === 'select' || p.type === 'multi_select' || p.type === 'status' ? { options: (p[p.type]?.options ?? []).map((o: any) => o.name) } : {}),
  }));
  const rows: DatabaseRow[] = [];
  let cursor: string | undefined;
  let more = false;
  while (rows.length < maxRows) {
    const res: any = await api.request('POST', `/v1/databases/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const r of res.results ?? []) {
      rows.push({ id: r.id, url: r.url, values: Object.fromEntries(columns.map((c) => [c.name, propText(r.properties?.[c.name])])) });
    }
    more = Boolean(res.has_more);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return { id: db.id ?? id, title: plain(db.title).trim() || 'Таблиця', url: db.url, lastEdited: db.last_edited_time, columns, rows: rows.slice(0, maxRows), more: more || rows.length > maxRows };
}

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').slice(0, 300);

export function databaseText(v: DatabaseView, withIds = false): string {
  const cols = v.columns.slice(0, 20);
  const head = `| ${withIds ? 'row_id | ' : ''}${cols.map((c) => cell(c.name)).join(' | ')} |`;
  const lines = [head, `|${(withIds ? [0, ...cols] : cols).map(() => ' --- ').join('|')}|`];
  for (const r of v.rows) lines.push(`| ${withIds ? `${r.id} | ` : ''}${cols.map((c) => cell(r.values[c.name] ?? '')).join(' | ')} |`);
  if (v.more) lines.push('…(є ще рядки)');
  return lines.join('\n');
}

/** One page (own blocks) or one database, as text. Throws NotionAccessError when the integration cannot see it. */
export async function readNotionDoc(api: NotionApi, id: string, opts: { maxBlocks?: number; database?: boolean } = {}): Promise<NotionDoc> {
  const asDatabase = async (): Promise<NotionDoc> => {
    try {
      const v = await readDatabase(api, id);
      return { id: v.id, kind: 'database', title: v.title, url: v.url, lastEdited: v.lastEdited, text: databaseText(v), childPages: [], childDatabases: [], linkedPages: [], links: [], files: [] };
    } catch (e) {
      if (accessError(e)) throw new NotionAccessError(ACCESS_HINT);
      throw e;
    }
  };
  if (opts.database) return asDatabase();
  let page: any;
  try {
    page = await api.request('GET', `/v1/pages/${id}`);
  } catch (e) {
    if (!accessError(e)) throw e;
    // a full-page database link looks just like a page link
    return asDatabase();
  }
  const w: Walk = { lines: [], childPages: [], childDatabases: [], linkedPages: new Set(), links: new Set(), files: [], blocks: 0, maxBlocks: opts.maxBlocks ?? 4000, cut: false };
  // a row of a database: its properties are part of the content
  if (page.parent?.type === 'database_id') {
    for (const [name, p] of Object.entries<any>(page.properties ?? {})) {
      if (p.type === 'title') continue;
      const v = propText(p);
      if (v) w.lines.push(`${name}: ${v}`);
    }
    if (w.lines.length) w.lines.push('');
  }
  await walk(api, page.id ?? id, '', 0, w);
  const text = w.lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    id: page.id ?? id,
    kind: 'page',
    title: pageTitle(page),
    url: page.url,
    lastEdited: page.last_edited_time,
    text,
    childPages: w.childPages,
    childDatabases: w.childDatabases,
    linkedPages: [...w.linkedPages],
    links: [...w.links],
    files: w.files,
    ...(w.cut ? { cut: true } : {}),
  };
}

/**
 * A page and everything inside it: sub-pages at any depth and inner databases, breadth-first, root first.
 * Pages the integration cannot open are skipped (the root must be readable).
 */
export async function readNotionTree(api: NotionApi, rootId: string, opts: { maxDocs?: number; maxBlocks?: number } = {}): Promise<NotionDoc[]> {
  const maxDocs = opts.maxDocs ?? 80;
  const root = await readNotionDoc(api, rootId, opts);
  const docs: NotionDoc[] = [root];
  const seen = new Set([root.id.replace(/-/g, '')]);
  type Ref = NotionRef & { database: boolean };
  const refs = (d: NotionDoc): Ref[] => [...d.childPages.map((p) => ({ ...p, database: false })), ...d.childDatabases.map((x) => ({ ...x, database: true }))];
  const queue: Ref[] = refs(root);
  while (queue.length && docs.length < maxDocs) {
    const ref = queue.shift()!;
    const key = ref.id.replace(/-/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const d = await readNotionDoc(api, ref.id, { ...opts, database: ref.database });
      // the block that links a sub-page carries its title even when the page object comes back bare
      if ((d.title === 'Без назви' || d.title === 'Таблиця') && ref.title) d.title = ref.title;
      docs.push(d);
      queue.push(...refs(d));
    } catch (e) {
      if (!(e instanceof NotionAccessError) && !accessError(e)) throw e;
    }
  }
  return docs;
}

/** The tree as one text: each page under its own heading. */
export function treeText(docs: NotionDoc[]): string {
  return docs.map((d, i) => (i === 0 ? `# ${d.title}\n\n${d.text}` : `\n\n# ${d.kind === 'database' ? '🗂' : '📄'} ${d.title}\n\n${d.text}`)).join('');
}

/** Pages shared with the integration whose title matches (Notion search). */
export async function searchNotion(api: NotionApi, query: string, limit = 10): Promise<Array<{ id: string; title: string; kind: 'page' | 'database'; url?: string }>> {
  const res: any = await api.request('POST', '/v1/search', { query, page_size: limit });
  return (res.results ?? []).map((r: any) => ({
    id: r.id,
    kind: r.object === 'database' ? 'database' : 'page',
    title: r.object === 'database' ? plain(r.title).trim() || 'Таблиця' : pageTitle(r),
    url: r.url,
  }));
}

/** Part `n` (1-based) of a long text, cut at paragraph boundaries. */
export function textPart(text: string, n: number, size = 9000): { text: string; part: number; parts: number } {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  parts.push(rest);
  const i = Math.min(Math.max(1, Math.floor(n) || 1), parts.length);
  return { text: parts[i - 1]!, part: i, parts: parts.length };
}
