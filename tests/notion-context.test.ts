import { describe, expect, it } from 'vitest';
import { clearContextCache, listSubPages, readPagesText, readSubPage } from '../src/notion/context.js';
import { buildTools } from '../src/agent/tools.js';
import { makeEnv } from './helpers/services.js';

const text = (type: string, t: string, extra: Record<string, unknown> = {}) => ({ id: `b-${t}`, type, has_children: false, [type]: { rich_text: [{ plain_text: t }] }, ...extra });

/** A read-only fake of the blocks endpoint: the owner's «Управлінський центр» with sub-pages. */
function fakeApi() {
  const tree: Record<string, any[]> = {
    center: [
      text('heading_2', 'Правила достовірності'),
      text('bulleted_list_item', 'Founder затверджує стратегічні рішення.'),
      { id: 'p-strategy', type: 'child_page', has_children: true, child_page: { title: 'MLI · Platform Strategy v3.0 · Founder Working' } },
      { id: 'p-week', type: 'child_page', has_children: true, child_page: { title: 'MLI · Founder Weekly Plan · 19–25.10.2026' } },
      { id: 'db-tasks', type: 'child_database', has_children: false, child_database: { title: 'MLI · Завдання та контроль' } },
      { ...text('toggle', 'Деталі'), id: 't1', has_children: true },
    ],
    t1: [text('paragraph', 'Прихований абзац у тогглі')],
    'p-strategy': [text('paragraph', 'P1: стратегія екосистеми MLI')],
    'p-week': [text('to_do', 'Зустріч з маркетологинею', { to_do: { rich_text: [{ plain_text: 'Зустріч з маркетологинею' }], checked: true } })],
  };
  const calls: string[] = [];
  return {
    calls,
    async request(method: string, path: string) {
      calls.push(`${method} ${path}`);
      const id = path.match(/blocks\/([^/]+)\/children/)?.[1] ?? '';
      return { results: tree[id] ?? [], has_more: false };
    },
  };
}

describe('owner context pages', () => {
  it('lists sub-pages and databases and opens toggles, only with GET', async () => {
    clearContextCache();
    const api = fakeApi();
    const ctx = await readPagesText(api as never, ['center']);
    expect(ctx).toContain('📄 Вкладена сторінка: «MLI · Platform Strategy v3.0 · Founder Working»');
    expect(ctx).toContain('🗂 Вкладена база: «MLI · Завдання та контроль»');
    expect(ctx).toContain('Прихований абзац у тогглі');
    expect((await listSubPages(api as never, ['center'])).map((p) => p.type)).toEqual(['page', 'page', 'database']);
    expect(await readSubPage(api as never, 'p-week')).toBe('- [x] Зустріч з маркетологинею');
    expect(api.calls.every((c) => c.startsWith('GET '))).toBe(true);
  });

  it('the agent tool reads a sub-page by part of its title and lists pages otherwise', async () => {
    const env = await makeEnv({ settings: { notionContextPages: ['center'] } });
    env.s.notionApi = fakeApi() as never;
    const tool = buildTools().find((t) => t.name === 'notion_page_read')!;
    const ctx = { s: env.s, chatId: 1, proposals: [] };
    expect(await tool.run({ title: 'strategy v3' }, ctx)).toMatchObject({ pages: [{ title: 'MLI · Platform Strategy v3.0 · Founder Working', text: 'P1: стратегія екосистеми MLI' }] });
    expect(((await tool.run({}, ctx)) as any).pages).toHaveLength(3);
    expect(await tool.run({ title: 'бюджет' }, ctx)).toMatchObject({ error: 'Сторінку «бюджет» не знайдено' });
  });
});
