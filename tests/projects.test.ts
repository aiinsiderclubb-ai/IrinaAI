import { describe, expect, it, vi } from 'vitest';
import { runPending } from '../src/actions.js';
import { buildSystemPrompt } from '../src/agent/agent.js';
import { runningJob, startJob } from '../src/agent/jobs.js';
import { buildTools } from '../src/agent/tools.js';
import { parseNotionId, readNotionTree, textPart, ACCESS_HINT } from '../src/notion/reader.js';
import { projectsOf } from '../src/projects/index.js';
import { notionChanged, syncProject } from '../src/projects/sync.js';
import { block, FakeNotionTree, linkText } from './helpers/fake-notion-tree.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

vi.mock('../src/integrations/webpage.js', () => {
  class WebPageError extends Error {}
  return {
    WebPageError,
    openPage: vi.fn(async (url: string) => {
      const base = { url, finalUrl: url, contacts: { emails: [], phones: [], messengers: [] }, keyLinks: [] };
      if (url.includes('files.example.com'))
        return { ...base, title: '', text: '', binary: { contentType: 'text/plain', data: new TextEncoder().encode('Специфікація: банка 0,33 л, пастеризація'), filename: 'spec.txt' } };
      if (url.includes('fermenta')) return { ...base, title: 'Fermenta', text: 'Контрактне виробництво напоїв. MOQ 10 000 банок.', contacts: { emails: ['sales@fermenta.example'], phones: [], messengers: [] } };
      return { ...base, title: `Сайт ${new URL(url).hostname}`, description: 'Опис сайту', text: 'Ми робимо газовані напої на замовлення.' };
    }),
  };
});

const ROOT = '11111111-1111-1111-1111-111111111111';
const SUB = '22222222-2222-2222-2222-222222222222';
const GRAND = '33333333-3333-3333-3333-333333333333';
const HIDDEN = '44444444-4444-4444-4444-444444444444';
const DB = '55555555-5555-5555-5555-555555555555';
const ROOT_LINK = `https://www.notion.so/ws/Igrystyi-chai-${ROOT.replace(/-/g, '')}?pvs=4`;

/** «Ігристий чай · ТЗ»: long brief with toggles, columns, a table, a sub-page in a column, a grandchild in a toggle, a hidden page, a database. */
function workspace(): FakeNotionTree {
  const n = new FakeNotionTree();
  const sections = Array.from({ length: 150 }, (_, i) => block(`s${i}`, 'paragraph', `Розділ ${i + 1}. ${'Опис вимог до продукту і виробника. '.repeat(3)}`));
  n.page(ROOT, 'Ігристий чай · ТЗ', [
    block('h1', 'heading_1', '1. Продукт'),
    { id: 'p1', type: 'paragraph', has_children: false, paragraph: { rich_text: [...linkText('сайт референсу', 'https://ref.example.com')] } },
    block('t1', 'toggle', 'Деталі', {}, true),
    { id: 'cl', type: 'column_list', has_children: true, column_list: {} },
    { id: 'tb', type: 'table', has_children: true, table: { table_width: 2, has_column_header: true } },
    { id: 'bm', type: 'bookmark', has_children: false, bookmark: { url: 'https://supplier.example.com', caption: [] } },
    { id: 'fl', type: 'file', has_children: false, file: { type: 'external', external: { url: 'https://files.example.com/spec.txt' }, name: 'spec.txt', caption: [] } },
    { id: HIDDEN, type: 'child_page', has_children: true, child_page: { title: 'Приватне' } },
    { id: DB, type: 'child_database', has_children: false, child_database: { title: 'Виробники' } },
    ...sections,
  ]);
  n.blocks.set('t1', [block('b1', 'bulleted_list_item', 'ABV до 0.5%', {}, true)]);
  n.blocks.set('b1', [block('b2', 'bulleted_list_item', 'вкладений пункт')]);
  n.blocks.set('cl', [
    { id: 'c1', type: 'column', has_children: true, column: {} },
    { id: 'c2', type: 'column', has_children: true, column: {} },
  ]);
  n.blocks.set('c1', [block('lc', 'paragraph', 'Ліва колонка')]);
  n.blocks.set('c2', [{ id: SUB, type: 'child_page', has_children: true, child_page: { title: 'Виробництво' } }]);
  n.blocks.set('tb', [
    { id: 'r1', type: 'table_row', table_row: { cells: [[{ plain_text: 'Параметр' }], [{ plain_text: 'Значення' }]] } },
    { id: 'r2', type: 'table_row', table_row: { cells: [[{ plain_text: 'Обсяг' }], [{ plain_text: '0,33 л' }]] } },
  ]);
  n.page(SUB, 'Виробництво', [block('sp', 'paragraph', 'Вимоги до виробника: ISO 22000'), block('st', 'toggle', 'Додатки', {}, true)]);
  n.blocks.set('st', [{ id: GRAND, type: 'child_page', has_children: true, child_page: { title: 'Розділ 12' } }]);
  n.page(GRAND, 'Розділ 12', [block('gp', 'paragraph', 'Пастеризація тунельна')]);
  n.page(HIDDEN, 'Приватне', [block('hp', 'paragraph', 'секрет')]);
  n.hidden.add(HIDDEN);
  n.dbs.set(DB, {
    title: 'Виробники',
    parent: ROOT,
    properties: { Назва: { type: 'title', title: {} }, Сайт: { type: 'url', url: {} }, Статус: { type: 'select', select: { options: [{ name: 'Новий' }] } } },
    rows: [{ id: 'row-a', properties: { Назва: { type: 'title', title: [{ plain_text: 'Fermenta' }] }, Сайт: { type: 'url', url: 'https://fermenta.example' }, Статус: { type: 'select', select: { name: 'Новий' } } } }],
  });
  return n;
}

const ctxOf = (env: Awaited<ReturnType<typeof makeEnv>>) => ({ s: env.s, chatId: 42, proposals: [] as any[] });
const tool = (name: string) => buildTools().find((t) => t.name === name)!;

describe('Notion links and deep reading', () => {
  it('finds the page id in every kind of Notion link', () => {
    const hex = '0123456789abcdef0123456789abcdef';
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    expect(parseNotionId(`https://www.notion.so/myws/Igrystyi-chai-${hex}?pvs=4`)).toBe(id);
    expect(parseNotionId(`https://ws.notion.site/${hex}`)).toBe(id);
    expect(parseNotionId(`https://www.notion.so/ws/${'f'.repeat(32)}?v=${'a'.repeat(32)}&p=${hex}&pm=s`)).toBe(id);
    expect(parseNotionId(id)).toBe(id);
    expect(parseNotionId(hex)).toBe(id);
    expect(parseNotionId('https://example.com/0123456789abcdef0123456789abcdef')).toBeUndefined();
    expect(parseNotionId('Ігристий чай')).toBeUndefined();
  });

  it('reads the whole tree: toggles, columns, tables, links, files, sub-pages at any depth, past 100 blocks', async () => {
    const docs = await readNotionTree(workspace() as never, ROOT);
    expect(docs.map((d) => d.title)).toEqual(['Ігристий чай · ТЗ', 'Виробництво', 'Виробники', 'Розділ 12']);
    const root = docs[0]!;
    expect(root.text).toContain('сайт референсу (https://ref.example.com)');
    expect(root.text).toContain('- ABV до 0.5%');
    expect(root.text).toContain('    - вкладений пункт');
    expect(root.text).toContain('Ліва колонка');
    expect(root.text).toContain('| Параметр | Значення |');
    expect(root.text).toContain('| Обсяг | 0,33 л |');
    expect(root.text).toContain('Розділ 150.');
    expect(root.links).toEqual(['https://ref.example.com', 'https://supplier.example.com']);
    expect(root.files.map((f) => f.name)).toEqual(['spec.txt']);
    expect(docs[2]!.text).toContain('| Fermenta | https://fermenta.example | Новий |');
    expect(docs[3]!.text).toBe('Пастеризація тунельна');
  });

  it('splits long text into parts on paragraph boundaries', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Абзац ${i} ${'x'.repeat(500)}`).join('\n\n');
    const one = textPart(text, 1, 4000);
    expect(one.parts).toBeGreaterThan(3);
    expect(one.text.endsWith('x')).toBe(true);
    expect(textPart(text, one.parts, 4000).text).toContain('Абзац 29');
    expect(textPart(text, 99, 4000).part).toBe(one.parts);
  });

  it('notion_page_read opens a link with all sub-pages and gives the rest by parts; no access → how to share', async () => {
    const env = await makeEnv();
    env.s.notionApi = workspace() as never;
    const first = (await tool('notion_page_read').run({ page: ROOT_LINK }, ctxOf(env))) as any;
    expect(first.title).toBe('Ігристий чай · ТЗ');
    expect(first.subpages_included).toEqual(['Виробництво', 'Виробники', 'Розділ 12']);
    expect(first.parts).toBeGreaterThan(1);
    expect(first.note).toContain('part=2');
    const last = (await tool('notion_page_read').run({ page: ROOT_LINK, part: first.parts }, ctxOf(env))) as any;
    expect(last.text).toContain('Пастеризація тунельна');
    const hidden = (await tool('notion_page_read').run({ page: HIDDEN }, ctxOf(env))) as any;
    expect(hidden).toEqual({ status: 'no_access', note: ACCESS_HINT });
  });
});

describe('project folders', () => {
  it('reads the Notion page with files and links into materials, writes the card, then only follows changes', async () => {
    const env = await makeEnv();
    const notion = workspace();
    env.s.notionApi = notion as never;
    env.llm.script = [say('Картка: Ігристий чай, безалкогольний, банка 0,33 л.')];
    const store = projectsOf(env.s);
    const p = await store.create({ name: 'Ігристий чай', notionId: ROOT, notionUrl: ROOT_LINK });

    const r = await syncProject(env.s, p);
    expect(r).toMatchObject({ pages: 3, tables: 1, files: 1, links: 2, errors: [] });
    const kinds = (await store.listMaterials(p.id)).map((m) => `${m.kind}:${m.title}`).sort();
    expect(kinds).toEqual(
      ['file:spec.txt', 'link:Сайт ref.example.com', 'link:Сайт supplier.example.com', 'notion:Ігристий чай · ТЗ', 'notion:Виробництво', 'notion:Розділ 12', 'notion_db:Виробники'].sort(),
    );
    expect((await store.get(p.id))!.summary).toBe('Картка: Ігристий чай, безалкогольний, банка 0,33 л.');
    // the summary request saw the brief
    expect(JSON.stringify(env.llm.calls.at(-1)!.messages)).toContain('ABV до 0.5%');

    // nothing changed: no new card
    const calls = env.llm.calls.length;
    expect(await notionChanged(env.s, (await store.get(p.id))!)).toBe(false);
    expect((await syncProject(env.s, (await store.get(p.id))!)).changed).toBe(0);
    expect(env.llm.calls.length).toBe(calls);

    // a page removed from Notion leaves the folder, the card is rewritten
    notion.blocks.set('st', []);
    notion.touch(SUB, '2026-11-12T09:00:00.000Z');
    expect(await notionChanged(env.s, (await store.get(p.id))!)).toBe(true);
    env.llm.script = [say('Картка v2')];
    await syncProject(env.s, (await store.get(p.id))!);
    expect((await store.listMaterials(p.id, { kinds: ['notion'] })).map((m) => m.title).sort()).toEqual(['Виробництво', 'Ігристий чай · ТЗ'].sort());
    expect((await store.get(p.id))!.summary).toBe('Картка v2');
  });

  it('finds materials by meaning and by words; the same source is stored once', async () => {
    const env = await makeEnv();
    const store = projectsOf(env.s);
    const p = await store.create({ name: 'Чай' });
    await store.addMaterial({ projectId: p.id, kind: 'note', title: 'Пастеризація', source: 'n1', text: 'Пастеризація тунельна при 65 градусах, банка алюмінієва.' });
    await store.addMaterial({ projectId: p.id, kind: 'note', title: 'Бюджет', source: 'n2', text: 'Бюджет на першу партію 20 000 євро.' });
    expect((await store.addMaterial({ projectId: p.id, kind: 'note', title: 'Бюджет', source: 'n2', text: 'Бюджет на першу партію 20 000 євро.' })).changed).toBe(false);
    expect(await store.listMaterials(p.id)).toHaveLength(2);
    const hits = await store.search('яка пастеризація потрібна', { projectId: p.id });
    expect(hits[0]!.title).toBe('Пастеризація');
    delete (env.llm as any).embed; // no embeddings: words still find it
    const kw = await store.search('бюджет партія', { projectId: p.id });
    expect(kw[0]!.title).toBe('Бюджет');
  });

  it('project_create reads the page in the background and the prompt then carries the card and materials', async () => {
    const env = await makeEnv();
    env.s.notionApi = workspace() as never;
    const told: string[] = [];
    env.s.deliver = { text: async (_c, md) => void told.push(md), card: async () => {} };
    env.llm.script = [say('Картка проєкту: ТЗ на ігристий чай')];
    const r = (await tool('project_create').run({ notion_link: ROOT_LINK }, ctxOf(env))) as any;
    expect(r).toMatchObject({ status: 'created', project: 'Ігристий чай · ТЗ' });
    await vi.waitFor(() => expect(told.join('\n')).toContain('прочитано: 3 сторінок, 1 таблиць, 1 файлів, 2 сайтів'), { timeout: 5000 });
    const prompt = await buildSystemPrompt(env.s);
    expect(prompt).toContain('АКТИВНИЙ ПРОЄКТ: «Ігристий чай · ТЗ»');
    expect(prompt).toContain('Картка проєкту: ТЗ на ігристий чай');
    expect(prompt).toMatch(/#\d+ 📎 spec\.txt/);
    // the same link again: switches, does not duplicate
    expect(((await tool('project_create').run({ notion_link: ROOT_LINK }, ctxOf(env))) as any).status).toBe('switched');
    expect(await projectsOf(env.s).list()).toHaveLength(1);
  });

  it('web_open reads several sites and keeps them in the project', async () => {
    const env = await makeEnv();
    const p = await projectsOf(env.s).create({ name: 'Чай' });
    await env.s.settings.update({ activeProjectId: p.id });
    const r = (await tool('web_open').run({ urls: ['https://fermenta.example', 'https://other.example'] }, ctxOf(env))) as any;
    expect(r.pages[0]).toMatchObject({ title: 'Fermenta', contacts: { emails: ['sales@fermenta.example'] } });
    expect(r.pages[0].text).toContain('MOQ 10 000');
    const mats = await projectsOf(env.s).listMaterials(p.id, { kinds: ['link'] });
    expect(mats.map((m) => m.title).sort()).toEqual(['Fermenta', 'Сайт other.example']);
  });
});

describe('Notion tables', () => {
  it('one confirmation updates a row found by name, adds a new one and a missing column', async () => {
    const env = await makeEnv();
    const notion = workspace();
    env.s.notionApi = notion as never;
    const ctx = ctxOf(env);
    const r = (await tool('notion_table_rows').run(
      {
        table: 'Виробники',
        rows: [
          { values: { Назва: 'fermenta', Статус: 'Написали, чекаємо', Ціна: '0,42 € за банку' } },
          { values: { Назва: 'Bubbly Co', Сайт: 'bubbly.example', Статус: 'Новий' } },
        ],
      },
      ctx,
    )) as any;
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.summary).toContain('➕ 1 нових');
    expect(r.summary).toContain('✏️ 1 оновлень');
    expect(r.summary).toContain('Нові колонки: Ціна');
    expect(notion.dbs.get(DB)!.rows).toHaveLength(1); // nothing written before the button

    const done = await runPending(env.s, ctx.proposals[0].id);
    expect(done.text).toContain('додано 1, оновлено 1');
    const rows = notion.dbs.get(DB)!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.properties['Статус'].select).toEqual({ name: 'Написали чекаємо' });
    expect(rows[0]!.properties['Ціна'].rich_text[0].plain_text).toBe('0,42 € за банку');
    expect(rows[1]!.properties['Сайт'].url).toBe('https://bubbly.example');
    expect(notion.dbs.get(DB)!.properties['Ціна'].type).toBe('rich_text');
  });

  it('a new table on the project page comes with its rows in one card', async () => {
    const env = await makeEnv();
    const notion = workspace();
    env.s.notionApi = notion as never;
    const p = await projectsOf(env.s).create({ name: 'Чай', notionId: ROOT });
    await projectsOf(env.s).addMaterial({ projectId: p.id, kind: 'notion', title: 'Ігристий чай · ТЗ', source: ROOT, text: 'ТЗ' });
    await env.s.settings.update({ activeProjectId: p.id });
    const ctx = ctxOf(env);
    const r = (await tool('notion_table_create').run(
      {
        title: 'Виробники 2',
        columns: [
          { name: 'Назва', type: 'title' },
          { name: 'Країна', type: 'select' },
          { name: 'MOQ', type: 'number' },
        ],
        rows: [{ values: { Назва: 'Fermenta', Країна: 'Польща', MOQ: '10 000' } }],
      },
      ctx,
    )) as any;
    expect(r.summary).toContain('«Виробники 2» + 1 рядків');
    expect(r.summary).toContain('Де: «Ігристий чай · ТЗ»');
    await runPending(env.s, ctx.proposals[0].id);
    const created = [...notion.dbs.values()].find((d) => d.title === 'Виробники 2')!;
    expect(created.parent).toBe(ROOT);
    expect(created.rows[0]!.properties['MOQ'].number).toBe(10000);
    expect((await projectsOf(env.s).listMaterials(p.id, { kinds: ['notion_db'] })).map((m) => m.title)).toEqual(['Виробники 2']);
  });
});

describe('background jobs', () => {
  it('works through many steps, reports progress, leaves a report and the cards', async () => {
    const env = await makeEnv();
    const p = await projectsOf(env.s).create({ name: 'Чай' });
    await env.s.settings.update({ activeProjectId: p.id });
    const told: string[] = [];
    const cards: string[] = [];
    env.s.deliver = { text: async (_c, md) => void told.push(md), card: async (_c, pa) => void cards.push(pa.kind) };
    env.llm.script = [
      toolCall('job_progress', { note: 'Знайшла 3 кандидати, перевіряю сайти' }),
      toolCall('material_save', { title: 'Нотатка', text: 'Fermenta відповідає критеріям' }),
      say('Підсумок: писати першими Fermenta.'),
    ];
    const started = await startJob(env.s, 42, 'Знайди виробників ігристого чаю за ТЗ і порівняй');
    expect('id' in started).toBe(true);
    expect('busy' in (await startJob(env.s, 42, 'Ще одне доручення'))).toBe(true);
    await vi.waitFor(async () => expect(await runningJob(env.s)).toBeUndefined(), { timeout: 5000 });
    expect(told).toEqual(['⏳ Знайшла 3 кандидати, перевіряю сайти', '✅ Підсумок: писати першими Fermenta.']);
    const reports = await projectsOf(env.s).listMaterials(p.id, { kinds: ['report'] });
    expect(reports[0]!.text).toBe('Підсумок: писати першими Fermenta.');
    // the job's own tools: no direct writes, only preparing
    const names = (env.llm.calls[0]!.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['web_search', 'web_open', 'project_search', 'notion_table_rows', 'job_progress']));
    expect(names).not.toContain('task_complete');
    expect(cards).toEqual([]);
  });
});
