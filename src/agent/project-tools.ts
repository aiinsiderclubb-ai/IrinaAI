import { z } from 'zod';
import { notionAccess } from '../integrations/runtime.js';
import { openPage, WebPageError } from '../integrations/webpage.js';
import { errMsg } from '../lib/log.js';
import { contextTree } from '../notion/context.js';
import {
  ACCESS_HINT,
  databaseText,
  NotionAccessError,
  parseNotionId,
  readDatabase,
  readNotionDoc,
  readNotionTree,
  searchNotion,
  textPart,
  treeText,
} from '../notion/reader.js';
import { COLUMN_TYPES, planUpsert, upsertSummary } from '../notion/tables.js';
import { activeProject, projectsOf, type Project } from '../projects/index.js';
import { contactsLine, fileToText, isSyncing, reportText, startSync } from '../projects/sync.js';
import { esc, type Services } from '../services.js';
import { propose, type Tool, type ToolContext } from './tools.js';

const PART = 9000;
const treeCache = new Map<string, { at: number; title: string; text: string; pages: string[] }>();

/** Says something to the owner outside the current answer (background work finished). */
export async function tell(s: Services, chatId: number, md: string): Promise<void> {
  if (s.deliver) await s.deliver.text(chatId, md);
  else await s.notify(esc(md));
}

interface Target {
  id: string;
  title?: string;
  database?: boolean;
}

/** A Notion page or table named by link, id or (part of) its title: the active project first, then the owner's center, then Notion search. */
async function findNotion(s: Services, q: string, want: 'page' | 'database' | 'any' = 'any'): Promise<Target | undefined> {
  const id = parseNotionId(q);
  if (id) return { id };
  const needle = q.trim().toLowerCase();
  if (!needle) return undefined;
  const fits = (kind: string) => want === 'any' || (want === 'database' ? kind === 'notion_db' || kind === 'database' : kind === 'notion' || kind === 'page');
  const project = await activeProject(s);
  const pick = <T extends { title: string }>(xs: T[]) => xs.find((x) => x.title.toLowerCase() === needle) ?? xs.find((x) => x.title.toLowerCase().includes(needle));
  if (project) {
    const mats = (await projectsOf(s).listMaterials(project.id, { kinds: ['notion', 'notion_db'], limit: 300 })).filter((m) => fits(m.kind));
    const hit = pick(mats);
    if (hit?.source) return { id: hit.source, title: hit.title, database: hit.kind === 'notion_db' };
  }
  const st = await s.settings.get();
  if (s.notionApi && st.notionContextPages.length) {
    const docs = (await contextTree(s.notionApi, st.notionContextPages)).filter((d) => fits(d.kind));
    const hit = pick(docs);
    if (hit) return { id: hit.id, title: hit.title, database: hit.kind === 'database' };
  }
  if (s.notionApi) {
    const found = (await searchNotion(s.notionApi, q, 10)).filter((r) => fits(r.kind));
    const hit = pick(found) ?? found[0];
    if (hit) return { id: hit.id, title: hit.title, database: hit.kind === 'database' };
  }
  return undefined;
}

/** Turns Notion errors into something the owner can act on. */
function notionError(e: unknown) {
  if (e instanceof NotionAccessError) return { status: 'no_access', note: ACCESS_HINT };
  return { status: 'error', note: errMsg(e).slice(0, 300) };
}

async function pageListing(s: Services) {
  const project = await activeProject(s);
  const out: Record<string, unknown> = {};
  if (project) {
    out.project_pages = (await projectsOf(s).listMaterials(project.id, { kinds: ['notion', 'notion_db'], limit: 100 })).map((m) => `${m.kind === 'notion_db' ? '🗂' : '📄'} ${m.title}`);
  }
  const st = await s.settings.get();
  if (s.notionApi && st.notionContextPages.length) {
    out.center_pages = (await contextTree(s.notionApi, st.notionContextPages)).slice(1).map((d) => `${d.kind === 'database' ? '🗂' : '📄'} ${d.title}`);
  }
  return out;
}

/** Where a new document or table goes: a named page, else the active project's page, else the owner's center. */
export async function parentPage(s: Services, under?: string): Promise<{ id: string; title: string } | { error: string }> {
  if (under?.trim()) {
    const t = await findNotion(s, under, 'page');
    if (!t) return { error: `Сторінку «${under}» не знайдено` };
    return { id: t.id, title: t.title ?? under };
  }
  const project = await activeProject(s);
  if (project?.notionId) {
    const root = (await projectsOf(s).listMaterials(project.id, { kinds: ['notion'], limit: 300 })).find((m) => m.source?.replace(/-/g, '') === project.notionId!.replace(/-/g, ''));
    if (root) return { id: project.notionId, title: root.title };
  }
  const st = await s.settings.get();
  if (st.notionContextPages[0]) return { id: st.notionContextPages[0], title: 'Управлінський центр' };
  return { error: 'Не знаю, куди покласти: немає активного проєкту зі сторінкою Notion' };
}

async function projectInfo(s: Services, p: Project, active?: number) {
  const counts = await projectsOf(s).countMaterials(p.id);
  return {
    id: p.id,
    name: p.name,
    active: p.id === active,
    notion: p.notionUrl,
    materials: counts,
    synced: p.syncedAt ? new Date(p.syncedAt).toISOString().slice(0, 16) : isSyncing(p.id) ? 'читаю зараз' : 'ще ні',
    ...(p.syncError ? { problems: p.syncError } : {}),
  };
}

async function activate(s: Services, p: Project): Promise<void> {
  await s.settings.update({ activeProjectId: p.id });
}

/** A new project folder from a Notion link (read in the background) or just a name. Also used by the bot's «Новий проєкт» button. */
export async function createProject(s: Services, chatId: number, a: { name?: string; notion_link?: string }): Promise<{ status: string; project?: string; note: string }> {
  const store = projectsOf(s);
  let notionId: string | undefined;
  let title: string | undefined;
  if (a.notion_link) {
    notionId = parseNotionId(a.notion_link);
    if (!notionId) return { status: 'error', note: 'Це не схоже на посилання Notion. Скопіюйте посилання сторінки: Share → Copy link.' };
    if (!s.notionApi) return { status: 'error', note: 'Notion не підключено' };
    try {
      title = (await readNotionDoc(s.notionApi, notionId, { maxBlocks: 1 })).title;
    } catch (e) {
      return notionError(e);
    }
    const existing = await store.findByNotion(notionId);
    if (existing) {
      await activate(s, existing);
      startSync(s, existing, (r) => tell(s, chatId, r instanceof Error ? `Не вдалося перечитати «${existing.name}»: ${r.message}` : reportText(existing, r)));
      return { status: 'switched', project: existing.name, note: 'Такий проєкт уже є: зробила активним і перечитую сторінку у фоні.' };
    }
  }
  const name = (a.name?.trim() || title || '').slice(0, 120);
  if (!name) return { status: 'error', note: 'Потрібна назва проєкту або посилання на його сторінку в Notion' };
  if (!notionId && (await store.find(name))?.name.toLowerCase() === name.toLowerCase()) return { status: 'exists', note: `Проєкт «${name}» уже є — перемкнись на нього через project_switch` };
  const p = await store.create({ name, notionId, notionUrl: a.notion_link });
  await activate(s, p);
  if (notionId) {
    startSync(s, p, (r) => tell(s, chatId, r instanceof Error ? `Не вдалося прочитати проєкт «${p.name}»: ${r.message}` : reportText(p, r)));
    return { status: 'created', project: p.name, note: 'Проєкт створено й зроблено активним. Сторінку з усіма підсторінками, файлами й посиланнями читаю у фоні — повідомлю, коли закінчу. Скажи про це коротко.' };
  }
  return { status: 'created', project: p.name, note: 'Проєкт без сторінки Notion: матеріали збиратимуться з чату (файли, посилання, нотатки).' };
}

export function projectTools(): Tool[] {
  const tools: Tool[] = [];
  const add = <T extends z.ZodType>(t: Tool<T>) => tools.push(t as unknown as Tool);

  add({
    name: 'notion_page_read',
    description:
      'Прочитати сторінку чи таблицю Notion ПОВНІСТЮ: за посиланням, id або назвою (сторінки активного проєкту, Управлінського центру, будь-які доступні асистенту). ' +
      'Разом з усіма вкладеними підсторінками будь-якої глибини, таблицями, колонками, розгортками. Довгий текст віддається частинами: part=2, 3… ' +
      'Без page — список доступних сторінок. Лише читання.',
    schema: z.object({
      page: z.string().optional().describe('Посилання на Notion, id або назва (частина назви)'),
      title: z.string().optional().describe('те саме, що page (стара назва параметра)'),
      part: z.number().int().min(1).optional().describe('Номер частини довгого тексту, з 1'),
    }),
    proposes: false,
    async run(a, { s }) {
      if (!s.notionApi) return { error: 'Notion не підключено' };
      const q = (a.page ?? a.title ?? '').trim();
      if (!q) return { pages: await pageListing(s) };
      let target: Target | undefined;
      try {
        target = await findNotion(s, q);
      } catch (e) {
        return notionError(e);
      }
      if (!target) return { error: `Сторінку «${q}» не знайдено`, ...(await pageListing(s)) };
      const key = target.id.replace(/-/g, '');
      let hit = treeCache.get(key);
      if (!hit || Date.now() - hit.at > 10 * 60_000) {
        try {
          const docs = target.database
            ? [await readNotionDoc(s.notionApi, target.id, { database: true })]
            : await readNotionTree(s.notionApi, target.id, { maxDocs: 40 });
          if (docs[0]!.title === 'Без назви' && target.title) docs[0]!.title = target.title;
          hit = { at: Date.now(), title: docs[0]!.title, text: treeText(docs), pages: docs.slice(1).map((d) => d.title) };
          treeCache.set(key, hit);
        } catch (e) {
          return notionError(e);
        }
      }
      const part = textPart(hit.text, a.part ?? 1, PART);
      return {
        title: hit.title,
        ...(hit.pages.length ? { subpages_included: hit.pages } : {}),
        part: part.part,
        parts: part.parts,
        text: part.text,
        ...(part.part < part.parts ? { note: `Це частина ${part.part} з ${part.parts}. Щоб дочитати — виклич знову з part=${part.part + 1}.` } : {}),
      };
    },
  });

  add({
    name: 'project_folders',
    description: 'Робочі папки проєктів (сторінка Notion + усі матеріали: ТЗ, файли, сайти, звіти): список, яка активна, скільки матеріалів, коли востаннє прочитано.',
    schema: z.object({}),
    proposes: false,
    async run(_a, { s }) {
      const active = (await s.settings.get()).activeProjectId;
      const list = await projectsOf(s).list();
      return { projects: await Promise.all(list.map((p) => projectInfo(s, p, active))) };
    },
  });

  add({
    name: 'project_create',
    description:
      'Додати новий проєкт як робочу папку: власниця дає назву і посилання на сторінку проєкту в Notion. Асистент сам прочитає всю сторінку з підсторінками, файлами й посиланнями ' +
      '(у фоні, 1–5 хв) і зробить проєкт активним. Нічого в Notion не змінює. Якщо проєкт з цією сторінкою вже є — просто перемикається на нього й перечитує.',
    schema: z.object({
      name: z.string().optional().describe('Назва проєкту; без неї — назва сторінки Notion'),
      notion_link: z.string().optional().describe('Посилання на головну сторінку проєкту в Notion'),
    }),
    proposes: false,
    run: (a, { s, chatId }) => createProject(s, chatId, a),
  });

  add({
    name: 'project_switch',
    description: 'Зробити проєкт активним (розмова далі про нього: його картка й матеріали під рукою). name="—" — вийти з проєкту.',
    schema: z.object({ name: z.string().min(1) }),
    proposes: false,
    async run(a, { s }) {
      if (/^(—|-|none|жоден|без проєкту)$/i.test(a.name.trim())) {
        await s.settings.update({ activeProjectId: undefined });
        return { status: 'ok', note: 'Активного проєкту немає' };
      }
      const p = await projectsOf(s).find(a.name);
      if (!p) return { status: 'not_found', projects: (await projectsOf(s).list()).map((x) => x.name) };
      await activate(s, p);
      return { status: 'ok', project: p.name, card: p.summary.slice(0, 1500) };
    },
  });

  add({
    name: 'project_sync',
    description: 'Перечитати сторінку активного проєкту в Notion зараз (якщо власниця щойно щось додала чи змінила). Зміни й так підтягуються щогодини.',
    schema: z.object({ name: z.string().optional() }),
    proposes: false,
    async run(a, { s, chatId }) {
      const p = a.name ? await projectsOf(s).find(a.name) : await activeProject(s);
      if (!p) return { status: 'error', note: 'Немає активного проєкту' };
      if (!p.notionId) return { status: 'error', note: 'У проєкту немає сторінки Notion' };
      const started = startSync(s, p, (r) => tell(s, chatId, r instanceof Error ? `Не вдалося перечитати «${p.name}»: ${r.message}` : reportText(p, r)));
      return { status: started ? 'started' : 'already_running', note: 'Перечитую у фоні, повідомлю.' };
    },
  });

  add({
    name: 'project_search',
    description:
      'Пошук ЗА ЗМІСТОМ у матеріалах проєкту: ТЗ і сторінки Notion, файли, відкриті сайти, нотатки, звіти, довгі повідомлення з чату. ' +
      'Використовуй перед тим, як питати власницю про деталі проєкту — відповідь, найімовірніше, вже є в матеріалах.',
    schema: z.object({
      query: z.string().min(2).describe('Що шукаємо, своїми словами'),
      everywhere: z.boolean().optional().describe('true — шукати в усіх проєктах, а не лише в активному'),
    }),
    proposes: false,
    async run(a, { s }) {
      const project = await activeProject(s);
      const hits = await projectsOf(s).search(a.query, { projectId: a.everywhere || !project ? undefined : project.id, limit: 8 });
      if (!hits.length) return { status: 'empty', note: 'У матеріалах нічого схожого' };
      return { hits: hits.map((h) => ({ material_id: h.materialId, title: h.title, kind: h.kind, source: h.source, text: h.text.slice(0, 1400) })) };
    },
  });

  add({
    name: 'material_read',
    description: 'Повний текст матеріалу проєкту за його id (з project_search, списку матеріалів чи відповіді web_open). Довгий — частинами: part=2, 3…',
    schema: z.object({ id: z.number().int(), part: z.number().int().min(1).optional() }),
    proposes: false,
    async run(a, { s }) {
      const m = await projectsOf(s).getMaterial(a.id);
      if (!m) return { status: 'not_found' };
      const part = textPart(m.text, a.part ?? 1, PART);
      return {
        id: m.id,
        title: m.title,
        kind: m.kind,
        source: m.source,
        part: part.part,
        parts: part.parts,
        text: part.text,
        ...(part.part < part.parts ? { note: `Частина ${part.part} з ${part.parts}; далі — part=${part.part + 1}` } : {}),
      };
    },
  });

  add({
    name: 'material_save',
    description: 'Зберегти в матеріали активного проєкту нотатку чи результат роботи (висновки, порівняння, чернетки листів), щоб потім знайти. Лише в пам’ять асистента, Notion не змінює.',
    schema: z.object({ title: z.string().min(1).max(200), text: z.string().min(1) }),
    proposes: false,
    async run(a, { s }) {
      const project = await activeProject(s);
      const { material } = await projectsOf(s).addMaterial({ projectId: project?.id, kind: 'note', title: a.title, text: a.text });
      return { status: 'saved', material_id: material.id, project: project?.name ?? null };
    },
  });

  add({
    name: 'web_open',
    description:
      'Відкрити сайт(и) за посиланням і прочитати сторінку: що це за компанія, продукти й можливості, умови, контакти (email, телефони, месенджери), корисні внутрішні сторінки (контакти, каталог, про нас). ' +
      'До 6 посилань за раз. Прочитане зберігається в матеріали активного проєкту (material_id — повний текст через material_read). Для пошуку, ЩО відкривати, — web_search.',
    schema: z.object({ urls: z.array(z.string().min(4)).min(1).max(6) }),
    proposes: false,
    async run(a, { s }) {
      const project = await activeProject(s);
      const each = a.urls.length === 1 ? 7000 : Math.floor(8500 / a.urls.length);
      const pages = await Promise.all(
        a.urls.map(async (url) => {
          try {
            const page = await openPage(url, { maxChars: 60_000 });
            let text = page.text;
            if (page.binary) text = (await fileToText(s, page.binary.data, page.binary.filename, page.binary.contentType)).text;
            let via = 'page';
            if (text.trim().length < 200) {
              // a page drawn by JavaScript: ask the search model to read it
              const w = await s.llm.webSearch(
                `Відкрий сторінку ${page.finalUrl} і перекажи українською її зміст детально: що це за компанія/сторінка, продукти й можливості, ціни й умови, мінімальні партії, контакти (email, телефони, адреса). Лише факти з цього сайту.`,
              );
              if (w.text.trim()) {
                text = `${text}\n\n${w.text}`.trim();
                via = 'search';
              }
            }
            const head = [page.description, contactsLine(page.contacts)].filter(Boolean).join('\n');
            const { material } = await projectsOf(s).addMaterial({
              projectId: project?.id,
              kind: 'link',
              title: page.title || page.finalUrl,
              source: page.finalUrl,
              text: head ? `${head}\n\n${text}` : text,
              meta: { contacts: page.contacts, requested: url },
            });
            return {
              url: page.finalUrl,
              title: page.title,
              description: page.description,
              contacts: page.contacts,
              key_links: page.keyLinks.slice(0, 8).map((l) => `${l.text} — ${l.url}`),
              text: text.slice(0, each),
              ...(text.length > each ? { more: `ще ${text.length - each} знаків — material_read(${material.id})` } : {}),
              material_id: material.id,
              ...(via === 'search' ? { note: 'сторінка малюється скриптом — зміст переказано пошуковою моделлю' } : {}),
            };
          } catch (e) {
            return { url, error: e instanceof WebPageError ? e.message : errMsg(e).slice(0, 200) };
          }
        }),
      );
      return { pages };
    },
  });

  add({
    name: 'notion_table_read',
    description: 'Прочитати таблицю (базу) Notion: колонки з типами й варіантами та всі рядки з row_id. За назвою, посиланням чи id. Перед оновленням рядків — читай, щоб узяти row_id.',
    schema: z.object({ table: z.string().min(1) }),
    proposes: false,
    async run(a, { s }) {
      if (!s.notionApi) return { error: 'Notion не підключено' };
      try {
        const t = await findNotion(s, a.table, 'database');
        if (!t) return { status: 'not_found', note: `Таблицю «${a.table}» не знайдено` };
        const v = await readDatabase(s.notionApi, t.id, 300);
        return {
          table_id: v.id,
          title: v.title,
          columns: v.columns.map((c) => `${c.name} (${c.type}${c.options?.length ? `: ${c.options.join(', ')}` : ''})`),
          rows: databaseText(v, true),
        };
      } catch (e) {
        return notionError(e);
      }
    },
  });

  add({
    name: 'notion_table_create',
    description:
      'Підготувати НОВУ таблицю (базу) в Notion — за замовчуванням на сторінці активного проєкту. Напр. «Виробники»: Назва (title), Сайт (url), Країна (select), Можливості (text), ' +
      'Мінімальна партія (text), Ціна (text), Контакти (text), Email (email), Статус (select: Новий, Написали, Відповів, Переговори, Відмова, Обраний), Джерело (url), Відкриті питання (text). ' +
      'Створюється після підтвердження власниці.',
    schema: z.object({
      title: z.string().min(1).max(200),
      columns: z
        .array(z.object({ name: z.string().min(1).max(100), type: z.enum(COLUMN_TYPES), options: z.array(z.string()).optional() }))
        .min(1)
        .max(30),
      under: z.string().optional().describe('Сторінка (назва чи посилання), де створити; без неї — сторінка активного проєкту'),
      rows: z.array(z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])) })).max(100).optional().describe('Одразу заповнити рядками (одне підтвердження на таблицю з рядками)'),
    }),
    proposes: true,
    async run(a, ctx) {
      const parent = await parentPage(ctx.s, a.under);
      if ('error' in parent) return { status: 'error', note: parent.error };
      const project = await activeProject(ctx.s);
      const cols = a.columns.map((c) => `${c.name}${c.type === 'title' ? ' (назва)' : ''}`).join(', ');
      const rows = a.rows ?? [];
      const preview = rows.length ? `\n${upsertSummary(a.title, { creates: rows, updates: [], newColumns: [] }, 10).split('\n').slice(1).join('\n')}` : '';
      return propose(
        ctx,
        'table.create',
        { title: a.title, columns: a.columns, parentId: parent.id, parentTitle: parent.title, projectId: project?.id, ...(rows.length ? { rows } : {}) },
        `🗂 Нова таблиця в Notion: «${a.title}»${rows.length ? ` + ${rows.length} рядків` : ''}\nДе: «${parent.title}»\nКолонки: ${cols}${preview}`,
      );
    },
  });

  add({
    name: 'notion_table_rows',
    description:
      'Підготувати ПАЧКУ змін у таблиці Notion (одне підтвердження на все): нові рядки й оновлення наявних. values — {назва колонки: значення}. ' +
      'Рядок з тією ж назвою (або з row_id) оновлюється, інакше додається. Невідомі колонки буде додано як текстові. Значення — лише з джерел (сайти, листи, ТЗ), без вигадок.',
    schema: z.object({
      table: z.string().min(1).describe('Назва таблиці, посилання чи id'),
      rows: z
        .array(
          z.object({
            row_id: z.string().optional(),
            values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])),
          }),
        )
        .min(1)
        .max(100),
    }),
    proposes: true,
    async run(a, ctx) {
      const { s } = ctx;
      if (!s.notionApi) return { error: 'Notion не підключено' };
      let t: Target | undefined;
      try {
        t = await findNotion(s, a.table, 'database');
      } catch (e) {
        return notionError(e);
      }
      if (!t) return { status: 'not_found', note: `Таблицю «${a.table}» не знайдено. Створи її через notion_table_create.` };
      let plan;
      try {
        plan = await planUpsert(s.notionApi, t.id, a.rows);
      } catch (e) {
        return notionError(e);
      }
      if (plan.updates.length && (await notionAccess(s)) !== 'full') {
        return { status: 'read_only', note: 'У Notion дозволено лише додавати нове: оновлення наявних рядків вимкнено (Опції → Підключення → Notion). Підготуй лише нові рядки.' };
      }
      const project = await activeProject(s);
      return propose(ctx, 'table.rows', { tableId: plan.table.id, tableTitle: plan.table.title, rows: a.rows, projectId: project?.id }, upsertSummary(plan.table.title, plan));
    },
  });

  return tools;
}

/** The project block of the system prompt: card, what is in the folder, how to use it. */
export async function projectPrompt(s: Services): Promise<string> {
  const list = await projectsOf(s).list();
  if (!list.length) {
    return 'ПРОЄКТИ-ПАПКИ: поки жодного. Коли власниця дає посилання на сторінку проєкту в Notion і каже працювати з ним — виклич project_create.';
  }
  const project = await activeProject(s);
  const others = list.filter((p) => p.id !== project?.id).map((p) => p.name);
  if (!project) return `ПРОЄКТИ-ПАПКИ: ${list.map((p) => p.name).join(', ')}. Активного немає — коли розмова про один із них, виклич project_switch.`;
  const mats = await projectsOf(s).listMaterials(project.id, { limit: 60 });
  const icon: Record<string, string> = { notion: '📄', notion_db: '🗂', file: '📎', link: '🌐', chat: '💬', note: '📝', report: '📊' };
  return [
    `АКТИВНИЙ ПРОЄКТ: «${project.name}»${project.notionUrl ? ` (Notion: ${project.notionUrl})` : ''}.${others.length ? ` Інші проєкти: ${others.join(', ')}.` : ''}`,
    project.summary ? `КАРТКА ПРОЄКТУ:\n${project.summary}` : isSyncing(project.id) ? 'Картка проєкту ще готується (сторінку читаю у фоні).' : '',
    mats.length ? `МАТЕРІАЛИ ПРОЄКТУ (#id — material_read; пошук за змістом — project_search):\n${mats.map((m) => `#${m.id} ${icon[m.kind] ?? '•'} ${m.title}`).join('\n')}` : '',
    'РОБОТА З ПРОЄКТОМ: усе потрібне вже є в матеріалах — шукай там (project_search, material_read, notion_page_read), а не проси власницю повторно надсилати чи пояснювати. ' +
      'Таблиці ведеш через notion_table_read / notion_table_rows (одна пачка змін — одне підтвердження). Великі доручення на 10+ кроків (знайти й порівняти виробників, зібрати таблицю з сайтів) — запускай через background_start.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pieces of the active project's materials that look relevant to the message (added to the turn as context). */
export async function relevantSnippets(s: Services, text: string): Promise<string> {
  if (text.trim().length < 12) return '';
  const project = await activeProject(s);
  if (!project) return '';
  try {
    const hits = (await projectsOf(s).search(text, { projectId: project.id, limit: 4 })).filter((h) => h.score >= 0.3);
    if (!hits.length) return '';
    return `МОЖЛИВО ДОРЕЧНІ ФРАГМЕНТИ З МАТЕРІАЛІВ ПРОЄКТУ «${project.name}» (довідка; повний текст — material_read):\n${hits
      .map((h) => `— #${h.materialId} «${h.title}»:\n${h.text.slice(0, 900)}`)
      .join('\n\n')}`;
  } catch {
    return '';
  }
}

export type { ToolContext };
