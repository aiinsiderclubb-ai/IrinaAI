import type { NotionApi } from './client.js';

const MAX_CHARS = 4000;
const TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; text: string }>();

const plain = (rich: any[] | undefined) => (rich ?? []).map((t) => t.plain_text ?? '').join('');

/** One block -> one line of text (headings, paragraphs, lists, to-dos, callouts, quotes). */
function blockLine(b: any): string {
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
    const lines: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res: any = await api.request('GET', `/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      for (const b of res.results ?? []) {
        const line = blockLine(b);
        if (line) lines.push(line);
      }
      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
    const text = lines.join('\n').trim();
    cache.set(id, { at: now, text });
    parts.push(text);
  }
  const all = parts.filter(Boolean).join('\n\n');
  return all.length > MAX_CHARS ? `${all.slice(0, MAX_CHARS)}\n…(скорочено)` : all;
}

export function clearContextCache(): void {
  cache.clear();
}
