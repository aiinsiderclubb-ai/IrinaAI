import type { NotionApi } from './client.js';

const MAX_CHARS = 9000;
/** one sub-page read on request */
const PAGE_MAX_CHARS = 12000;
const TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; text: string }>();

const plain = (rich: any[] | undefined) => (rich ?? []).map((t) => t.plain_text ?? '').join('');

/** One block -> one line of text (headings, paragraphs, lists, to-dos, callouts, quotes). */
function blockLine(b: any): string {
  // sub-pages and databases have no text of their own: list them so the assistant knows what can be opened
  if (b.type === 'child_page') return `📄 Вкладена сторінка: «${b.child_page?.title ?? ''}»`;
  if (b.type === 'child_database') return `🗂 Вкладена база: «${b.child_database?.title ?? ''}»`;
  const v = b[b.type];
  const text = plain(v?.rich_text);
  if (!text.trim()) return '';
  switch (b.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      return `\n## ${text}`;
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return `- ${text}`;
    case 'to_do':
      return `- [${v.checked ? 'x' : ' '}] ${text}`;
    default:
      return text;
  }
}

/**
 * Reads the owner's own pages (e.g. «Управлінський центр») as plain text for the prompt.
 * Read-only by design: only GET requests, nothing in the owner's Notion is ever changed here.
 */
export async function readPagesText(api: NotionApi, pageIds: string[], now = Date.now()): Promise<string> {
  const parts: string[] = [];
  for (const id of pageIds) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) {
      parts.push(hit.text);
      continue;
    }
    const text = (await pageLines(api, id)).join('\n').trim();
    cache.set(id, { at: now, text });
    parts.push(text);
  }
  const all = parts.filter(Boolean).join('\n\n');
  return all.length > MAX_CHARS ? `${all.slice(0, MAX_CHARS)}\n…(скорочено)` : all;
}

async function children(api: NotionApi, id: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const res: any = await api.request('GET', `/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...(res.results ?? []));
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return out;
}

/** Text of a page; toggles and nested lists are opened one level down. */
async function pageLines(api: NotionApi, id: string): Promise<string[]> {
  const lines: string[] = [];
  for (const b of await children(api, id)) {
    const line = blockLine(b);
    if (line) lines.push(line);
    if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') {
      for (const nb of await children(api, b.id)) {
        const nl = blockLine(nb);
        if (nl) lines.push(`  ${nl}`);
      }
    }
  }
  return lines;
}

export interface SubPage {
  id: string;
  title: string;
  type: 'page' | 'database';
  /** the context page it sits in */
  parent: string;
}

/** Sub-pages and databases directly inside the owner's context pages. */
export async function listSubPages(api: NotionApi, pageIds: string[]): Promise<SubPage[]> {
  const out: SubPage[] = [];
  for (const id of pageIds) {
    for (const b of await children(api, id)) {
      if (b.type === 'child_page') out.push({ id: b.id, title: b.child_page?.title ?? '', type: 'page', parent: id });
      if (b.type === 'child_database') out.push({ id: b.id, title: b.child_database?.title ?? '', type: 'database', parent: id });
    }
  }
  return out;
}

/** Reads one sub-page as text, read-only. */
export async function readSubPage(api: NotionApi, id: string): Promise<string> {
  const text = (await pageLines(api, id)).join('\n').trim();
  return text.length > PAGE_MAX_CHARS ? `${text.slice(0, PAGE_MAX_CHARS)}\n…(скорочено)` : text;
}

export function clearContextCache(): void {
  cache.clear();
}
