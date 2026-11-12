import type { NotionApi } from './client.js';
import { readDatabase, type DatabaseView } from './reader.js';

/** Column types the assistant can create; Notion's «status» cannot be created through the API, so statuses are selects. */
export const COLUMN_TYPES = ['title', 'text', 'url', 'email', 'phone', 'number', 'select', 'multi_select', 'date', 'checkbox'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  options?: string[];
}

export type CellValue = string | number | boolean | string[] | null;

export interface RowInput {
  /** Notion id of an existing row (from notion_table_read); without it a row with the same title is updated or a new one added */
  row_id?: string;
  values: Record<string, CellValue>;
}

/** Notion rejects commas in select option names. */
const optionName = (v: string) => v.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

function schemaFor(c: ColumnSpec): Record<string, unknown> {
  const opts = (c.options ?? []).map((o) => ({ name: optionName(o) })).filter((o) => o.name);
  switch (c.type) {
    case 'title':
      return { title: {} };
    case 'url':
      return { url: {} };
    case 'email':
      return { email: {} };
    case 'phone':
      return { phone_number: {} };
    case 'number':
      return { number: { format: 'number' } };
    case 'select':
      return { select: { options: opts } };
    case 'multi_select':
      return { multi_select: { options: opts } };
    case 'date':
      return { date: {} };
    case 'checkbox':
      return { checkbox: {} };
    default:
      return { rich_text: {} };
  }
}

/** Creates an inline table on a page. The first «title» column (or the first column) becomes the row name. */
export async function createTable(api: NotionApi, parentPageId: string, title: string, columns: ColumnSpec[]): Promise<{ id: string; url?: string }> {
  const cols = columns.filter((c) => c.name.trim());
  let titleIdx = cols.findIndex((c) => c.type === 'title');
  if (titleIdx < 0) titleIdx = 0;
  const properties: Record<string, unknown> = {};
  cols.forEach((c, i) => {
    properties[c.name.trim().slice(0, 100)] = i === titleIdx ? { title: {} } : schemaFor(c.type === 'title' ? { ...c, type: 'text' } : c);
  });
  if (!cols.length) properties['Назва'] = { title: {} };
  const db: any = await api.request('POST', '/v1/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    is_inline: true,
    title: [{ type: 'text', text: { content: title.slice(0, 200) } }],
    properties,
  });
  return { id: db.id, url: db.url };
}

const rich = (v: string) => [{ type: 'text', text: { content: v.slice(0, 1900) } }];

/** "1 200,50 $" -> 1200.5 */
export function parseNumber(v: CellValue): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = v.replace(/\s| /g, '').match(/-?\d+(?:[.,]\d+)*/);
  if (!m) return undefined;
  let n = m[0];
  if (/,\d{1,2}$/.test(n) && !n.includes('.')) n = n.replace(',', '.');
  n = n.replace(/,/g, '');
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}

const asText = (v: CellValue) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

/** One value in the property's own format; undefined = cannot be written (reported back). */
export function propValue(type: string, v: CellValue): unknown {
  const text = asText(v).trim();
  switch (type) {
    case 'title':
      return { title: rich(text) };
    case 'rich_text':
      return { rich_text: text ? rich(text) : [] };
    case 'number': {
      if (v === null || text === '') return { number: null };
      const n = parseNumber(v);
      return n === undefined ? undefined : { number: n };
    }
    case 'select':
      return { select: text ? { name: optionName(text) } : null };
    case 'status':
      return text ? { status: { name: text } } : undefined;
    case 'multi_select': {
      const items = Array.isArray(v) ? v : text.split(/[,;]/);
      return { multi_select: items.map((x) => optionName(String(x))).filter(Boolean).map((name) => ({ name })) };
    }
    case 'url':
      return { url: text ? (/^https?:\/\//i.test(text) ? text : `https://${text}`) : null };
    case 'email':
      return { email: text || null };
    case 'phone_number':
      return { phone_number: text || null };
    case 'date': {
      if (!text) return { date: null };
      const m = text.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)?/);
      return m ? { date: { start: m[0] } } : undefined;
    }
    case 'checkbox':
      return { checkbox: typeof v === 'boolean' ? v : /^(так|yes|true|1|✓|✔|x|да)$/i.test(text) };
    default:
      return undefined;
  }
}

export interface UpsertPlan {
  table: DatabaseView;
  /** rows to add / to change; `matched` = found by title */
  creates: RowInput[];
  updates: Array<RowInput & { row_id: string; label: string }>;
  /** columns the table does not have yet: added as text columns */
  newColumns: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Column name as the table spells it (case and spaces do not matter). */
function resolveColumn(table: DatabaseView, name: string) {
  return table.columns.find((c) => c.name === name) ?? table.columns.find((c) => norm(c.name) === norm(name));
}

/** Splits rows into updates (by id or by the same name) and new rows, and finds columns the table lacks. */
export async function planUpsert(api: NotionApi, tableId: string, rows: RowInput[]): Promise<UpsertPlan> {
  const table = await readDatabase(api, tableId, 1000);
  const titleCol = table.columns.find((c) => c.type === 'title');
  const byTitle = new Map(table.rows.map((r) => [norm(titleCol ? (r.values[titleCol.name] ?? '') : ''), r]));
  const byId = new Map(table.rows.map((r) => [r.id.replace(/-/g, ''), r]));
  const plan: UpsertPlan = { table, creates: [], updates: [], newColumns: [] };
  for (const row of rows) {
    for (const k of Object.keys(row.values)) if (!resolveColumn(table, k) && !plan.newColumns.includes(k.trim())) plan.newColumns.push(k.trim());
    const titleValue = titleCol ? Object.entries(row.values).find(([k]) => norm(k) === norm(titleCol.name))?.[1] : undefined;
    const existing = (row.row_id && byId.get(row.row_id.replace(/-/g, ''))) || (titleValue ? byTitle.get(norm(asText(titleValue))) : undefined);
    if (existing) plan.updates.push({ ...row, row_id: existing.id, label: titleCol ? existing.values[titleCol.name] || 'рядок' : 'рядок' });
    else plan.creates.push(row);
  }
  return plan;
}

function propsFor(table: DatabaseView, values: Record<string, CellValue>, skipped: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const col = resolveColumn(table, k);
    const type = col ? (col.type === 'title' ? 'title' : col.type) : 'rich_text';
    const name = col?.name ?? k.trim();
    const pv = propValue(type, v);
    if (pv === undefined) skipped.push(`${name}: «${asText(v).slice(0, 40)}»`);
    else props[name] = pv;
  }
  return props;
}

/** Writes the rows: missing columns are added as text, then rows are updated or created. */
export async function applyUpsert(api: NotionApi, tableId: string, rows: RowInput[]): Promise<{ created: number; updated: number; skipped: string[]; url?: string }> {
  const plan = await planUpsert(api, tableId, rows);
  if (plan.newColumns.length) {
    await api.request('PATCH', `/v1/databases/${tableId}`, { properties: Object.fromEntries(plan.newColumns.map((c) => [c.slice(0, 100), { rich_text: {} }])) });
    for (const c of plan.newColumns) plan.table.columns.push({ name: c.slice(0, 100), type: 'rich_text' });
  }
  const skipped: string[] = [];
  for (const u of plan.updates) await api.request('PATCH', `/v1/pages/${u.row_id}`, { properties: propsFor(plan.table, u.values, skipped) });
  for (const c of plan.creates) await api.request('POST', '/v1/pages', { parent: { database_id: tableId }, properties: propsFor(plan.table, c.values, skipped) });
  return { created: plan.creates.length, updated: plan.updates.length, skipped, url: plan.table.url };
}

/** A short human-readable preview of the change for the confirm card. */
export function upsertSummary(tableTitle: string, plan: Pick<UpsertPlan, 'creates' | 'updates' | 'newColumns'>, max = 12): string {
  const head = [`🗂 Таблиця «${tableTitle}»:`, plan.creates.length ? `➕ ${plan.creates.length} нових` : '', plan.updates.length ? `✏️ ${plan.updates.length} оновлень` : '']
    .filter(Boolean)
    .join(' ');
  const line = (r: RowInput, label?: string) => {
    const vals = Object.entries(r.values)
      .filter(([, v]) => asText(v).trim())
      .map(([k, v]) => `${k}: ${asText(v).slice(0, 60)}`);
    return `${label ? `✏️ ${label} → ` : '➕ '}${vals.slice(0, 5).join('; ')}${vals.length > 5 ? '…' : ''}`;
  };
  const lines = [...plan.updates.map((u) => line(u, (u as any).label)), ...plan.creates.map((c) => line(c))];
  return [head, ...lines.slice(0, max), lines.length > max ? `…і ще ${lines.length - max}` : '', plan.newColumns.length ? `Нові колонки: ${plan.newColumns.join(', ')}` : '']
    .filter(Boolean)
    .join('\n');
}
