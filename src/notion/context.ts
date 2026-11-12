import type { NotionApi } from './client.js';
import { readNotionDoc, readNotionTree, type NotionDoc } from './reader.js';

const MAX_CHARS = 9000;
/** one sub-page read on request */
const PAGE_MAX_CHARS = 12000;
const TTL_MS = 30 * 60_000;
const TREE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; text: string }>();
const trees = new Map<string, { at: number; docs: NotionDoc[] }>();

/**
 * Reads the owner's own pages (e.g. «Управлінський центр») as plain text for the prompt: the page's whole block tree
 * (toggles, columns, tables), sub-pages listed by title. Read-only: only GET requests.
 */
export async function readPagesText(api: NotionApi, pageIds: string[], now = Date.now()): Promise<string> {
  const parts: string[] = [];
  for (const id of pageIds) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) {
      parts.push(hit.text);
      continue;
    }
    const text = (await readNotionDoc(api, id)).text;
    cache.set(id, { at: now, text });
    parts.push(text);
  }
  const all = parts.filter(Boolean).join('\n\n');
  return all.length > MAX_CHARS ? `${all.slice(0, MAX_CHARS)}\n…(скорочено — повний текст відкривай через notion_page_read)` : all;
}

/** The context pages with everything inside them (cached for 10 minutes). */
export async function contextTree(api: NotionApi, pageIds: string[], now = Date.now()): Promise<NotionDoc[]> {
  const key = pageIds.join(',');
  const hit = trees.get(key);
  if (hit && now - hit.at < TREE_TTL_MS) return hit.docs;
  const docs: NotionDoc[] = [];
  for (const id of pageIds) docs.push(...(await readNotionTree(api, id, { maxDocs: 60 })));
  trees.set(key, { at: now, docs });
  return docs;
}

export interface SubPage {
  id: string;
  title: string;
  type: 'page' | 'database';
  /** the context page it sits in */
  parent: string;
}

/** Sub-pages and databases inside the owner's context pages, at any depth. */
export async function listSubPages(api: NotionApi, pageIds: string[]): Promise<SubPage[]> {
  const out: SubPage[] = [];
  for (const id of pageIds) {
    for (const d of (await contextTree(api, [id])).slice(1)) out.push({ id: d.id, title: d.title, type: d.kind, parent: id });
  }
  return out;
}

/** Reads one sub-page as text, read-only. */
export async function readSubPage(api: NotionApi, id: string): Promise<string> {
  const text = (await readNotionDoc(api, id)).text;
  return text.length > PAGE_MAX_CHARS ? `${text.slice(0, PAGE_MAX_CHARS)}\n…(скорочено)` : text;
}

export function clearContextCache(): void {
  cache.clear();
  trees.clear();
}
