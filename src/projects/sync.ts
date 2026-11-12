import { extractText, fileKind } from '../files/extract.js';
import { openPage } from '../integrations/webpage.js';
import { errMsg } from '../lib/log.js';
import { readNotionTree, type NotionDoc } from '../notion/reader.js';
import type { Services } from '../services.js';
import { projectsOf } from './index.js';
import type { Material, Project } from './store.js';

export interface SyncReport {
  pages: number;
  tables: number;
  files: number;
  links: number;
  changed: number;
  errors: string[];
}

const MAX_FILES = 15;
const MAX_LINKS = 20;
const LINK_REFRESH_MS = 7 * 24 * 3600_000;

const sameId = (a?: string, b?: string) => Boolean(a && b && a.replace(/-/g, '') === b.replace(/-/g, ''));

/** A file from a URL (Notion attachment or a link to a document) as text; empty when it cannot be read. */
export async function readRemoteFile(s: Services, url: string, name: string): Promise<{ text: string; links: string[] }> {
  const page = await openPage(url, { maxBytes: 20 * 1024 * 1024, timeoutMs: 60_000 });
  if (!page.binary) return { text: page.text, links: page.keyLinks.map((l) => l.url) };
  const { data, contentType, filename } = page.binary;
  const fname = /\.\w{2,5}$/.test(name) ? name : filename;
  return fileToText(s, data, fname, contentType);
}

/** Any supported file as text; a scanned PDF goes to the vision model. */
export async function fileToText(s: Services, data: Uint8Array, name: string, mime?: string): Promise<{ text: string; links: string[] }> {
  const kind = fileKind(name, mime);
  if (kind === 'image') {
    if (!s.llm.see) return { text: '', links: [] };
    return { text: await s.llm.see({ data, mime: mime?.startsWith('image/') ? mime : 'image/jpeg', name }, IMAGE_PROMPT), links: [] };
  }
  const ex = await extractText(data, name, mime);
  if (!ex.text.trim() && ex.kind === 'pdf' && s.llm.see) {
    return { text: await s.llm.see({ data, mime: 'application/pdf', name }, SCAN_PROMPT), links: ex.links };
  }
  return { text: ex.text, links: ex.links };
}

export const IMAGE_PROMPT =
  'Опиши українською, що на зображенні, і перепиши весь текст з нього дослівно (таблиці — рядками | a | b |). ' +
  'Якщо це скриншот листування, документа чи сайту — передай зміст повністю: імена, суми, дати, умови, контакти. Без вступів. ' +
  'НЕ ВИГАДУЙ: пиши лише те, що справді видно. Якщо зображення порожнє, темне чи текст не читається — так і напиши одним реченням.';
const SCAN_PROMPT =
  'Це скан документа. Перепиши весь текст дослівно, зберігаючи структуру (заголовки, списки, таблиці рядками | a | b |). Без коментарів. ' +
  'Не вигадуй: якщо сторінка порожня чи нечитабельна — так і напиши.';

const SUMMARY_PROMPT = [
  'Ти ведеш робочий проєкт власниці. За матеріалами склади КАРТКУ ПРОЄКТУ українською (до 2500 знаків), лише з фактів у матеріалах:',
  '1) Суть і мета.',
  '2) Продукт і ключові вимоги ТЗ: цифри, обсяги, бюджети, терміни, стандарти — дослівно.',
  '3) Критерії відбору (виробників, підрядників, постачальників), якщо є.',
  '4) Що вже зроблено і поточний стан.',
  '5) Відкриті питання та ризики.',
  '6) Де що лежить: назви сторінок, таблиць, файлів.',
  'Стисло, списками, без вступів і без вигадок. Чого немає в матеріалах — не пиши.',
].join('\n');

/** Rewrites the project card from its materials. */
export async function summarizeProject(s: Services, project: Project): Promise<string> {
  const store = projectsOf(s);
  const mats = await store.listMaterials(project.id, { limit: 120 });
  if (!mats.length) return '';
  const rank = (m: Material) => (sameId(m.source, project.notionId) ? 0 : m.kind === 'notion' ? 1 : m.kind === 'notion_db' ? 2 : m.kind === 'file' ? 3 : m.kind === 'report' ? 4 : 5);
  mats.sort((a, b) => rank(a) - rank(b));
  let budget = 45_000;
  const parts: string[] = [];
  for (const m of mats) {
    if (budget <= 500) break;
    const cap = rank(m) === 0 ? Math.min(20_000, budget) : Math.min(6_000, budget);
    const body = m.text.slice(0, cap);
    budget -= body.length;
    parts.push(`## ${m.title} (${m.kind})\n${body}`);
  }
  const res = await s.llm.chat({
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `Проєкт «${project.name}».\n\n${parts.join('\n\n')}` },
    ],
    temperature: 0.2,
    maxTokens: 1600,
  });
  return (res.content ?? '').trim().slice(0, 4000);
}

/**
 * Reads the project's Notion page with everything inside (sub-pages, tables, attached files, links) into materials.
 * Unchanged pages are not re-indexed; pages removed from Notion are dropped. The card is rewritten when something changed.
 */
export async function syncProject(s: Services, project: Project): Promise<SyncReport> {
  const store = projectsOf(s);
  const report: SyncReport = { pages: 0, tables: 0, files: 0, links: 0, changed: 0, errors: [] };
  let docs: NotionDoc[] = [];
  if (project.notionId) {
    if (!s.notionApi) throw new Error('Notion не підключено');
    docs = await readNotionTree(s.notionApi, project.notionId, { maxDocs: 80 });
    const changedDocs = new Set<string>();
    for (const d of docs) {
      const { changed } = await store.addMaterial({
        projectId: project.id,
        kind: d.kind === 'database' ? 'notion_db' : 'notion',
        title: d.title,
        source: d.id,
        text: d.text,
        meta: { url: d.url, lastEdited: d.lastEdited, links: d.links.slice(0, 60) },
      });
      if (d.kind === 'database') report.tables++;
      else report.pages++;
      if (changed) {
        report.changed++;
        changedDocs.add(d.id);
      }
    }
    // pages deleted or moved out of the project
    const ids = new Set(docs.map((d) => d.id.replace(/-/g, '')));
    for (const m of await store.listMaterials(project.id, { kinds: ['notion', 'notion_db'], limit: 500 })) {
      if (m.source && !ids.has(m.source.replace(/-/g, ''))) {
        await store.deleteMaterial(m.id);
        report.changed++;
      }
    }

    // files attached in Notion: read again only when their page changed
    const known = new Set((await store.listMaterials(project.id, { kinds: ['file'], limit: 500 })).map((m) => m.source));
    const files = docs.flatMap((d) => d.files.map((f) => ({ ...f, doc: d.id })));
    for (const f of files.slice(0, MAX_FILES)) {
      const source = f.hosted === 'external' ? f.url : `notion-file:${f.blockId}`;
      if (known.has(source) && !changedDocs.has(f.doc)) continue;
      try {
        const { text, links } = await readRemoteFile(s, f.url, f.name);
        if (!text.trim()) continue;
        const { changed } = await store.addMaterial({ projectId: project.id, kind: 'file', title: f.name, source, text, meta: { links: links.slice(0, 60), fromNotion: true } });
        report.files++;
        if (changed) report.changed++;
      } catch (e) {
        report.errors.push(`Файл «${f.name}»: ${errMsg(e).slice(0, 120)}`);
      }
    }
  }

  // links from the pages and files: each site read once a week at most
  const linkMats = await store.listMaterials(project.id, { kinds: ['link'], limit: 500 });
  const fresh = new Map(linkMats.map((m) => [m.source, m]));
  const fileLinks = (await store.listMaterials(project.id, { kinds: ['file'], limit: 100 })).flatMap((m) => (m.meta.links as string[] | undefined) ?? []);
  const urls = [...new Set([...docs.flatMap((d) => d.links), ...fileLinks])].filter((u) => /^https?:\/\//i.test(u));
  let opened = 0;
  for (const url of urls) {
    if (opened >= MAX_LINKS) break;
    const old = fresh.get(url);
    if (old && Date.now() - new Date(old.updatedAt).getTime() < LINK_REFRESH_MS) continue;
    opened++;
    try {
      const page = await openPage(url, { maxChars: 40_000 });
      let text = page.text;
      if (page.binary) text = (await fileToText(s, page.binary.data, page.binary.filename, page.binary.contentType)).text;
      if (!text.trim()) continue;
      const head = [page.description, contactsLine(page.contacts)].filter(Boolean).join('\n');
      const { changed } = await store.addMaterial({
        projectId: project.id,
        kind: 'link',
        title: page.title || url,
        source: url,
        text: head ? `${head}\n\n${text}` : text,
        meta: { finalUrl: page.finalUrl, contacts: page.contacts },
      });
      report.links++;
      if (changed) report.changed++;
    } catch (e) {
      report.errors.push(`${url}: ${errMsg(e).slice(0, 100)}`);
    }
  }

  const fresher = await store.get(project.id);
  if (report.changed || !fresher?.summary) {
    try {
      const summary = await summarizeProject(s, fresher ?? project);
      if (summary) await store.update(project.id, { summary });
    } catch (e) {
      report.errors.push(`Картка проєкту: ${errMsg(e).slice(0, 120)}`);
    }
  }
  await store.update(project.id, { syncedAt: new Date(), syncError: report.errors.length ? report.errors.slice(0, 5).join('; ') : '' });
  return report;
}

export function contactsLine(c?: { emails: string[]; phones: string[]; messengers: string[] }): string {
  if (!c) return '';
  const parts = [c.emails.length ? `Email: ${c.emails.join(', ')}` : '', c.phones.length ? `Тел.: ${c.phones.join(', ')}` : '', c.messengers.length ? `Месенджери: ${c.messengers.join(', ')}` : ''];
  return parts.filter(Boolean).join(' · ');
}

const running = new Set<number>();

/** Sync in the background; `done` gets the report (or the error) when it finishes. Returns false if one is already running. */
export function startSync(s: Services, project: Project, done?: (r: SyncReport | Error) => Promise<void> | void): boolean {
  if (running.has(project.id)) return false;
  running.add(project.id);
  void syncProject(s, project)
    .then(async (r) => void (await done?.(r)))
    .catch(async (e) => {
      s.log.warn('project_sync_failed', { project: project.id, error: errMsg(e).slice(0, 200) });
      await projectsOf(s).update(project.id, { syncError: errMsg(e).slice(0, 300) });
      await done?.(e instanceof Error ? e : new Error(String(e)));
    })
    .finally(() => running.delete(project.id));
  return true;
}

export function isSyncing(projectId: number): boolean {
  return running.has(projectId);
}

/** Did anything in the project's Notion pages change since the last read? (one cheap request per page) */
export async function notionChanged(s: Services, project: Project): Promise<boolean> {
  if (!project.notionId || !s.notionApi) return false;
  const mats = await projectsOf(s).listMaterials(project.id, { kinds: ['notion', 'notion_db'], limit: 120 });
  if (!mats.length) return true;
  for (const m of mats) {
    try {
      const path = m.kind === 'notion_db' ? `/v1/databases/${m.source}` : `/v1/pages/${m.source}`;
      const obj: any = await s.notionApi.request('GET', path);
      if (obj.last_edited_time && obj.last_edited_time !== m.meta.lastEdited) return true;
    } catch {
      return true; // deleted or access removed: a full read sorts it out
    }
  }
  return false;
}

/** Scheduler: re-reads projects whose Notion pages changed. */
export async function refreshProjects(s: Services): Promise<void> {
  for (const p of await projectsOf(s).list()) {
    if (!p.notionId || running.has(p.id)) continue;
    if (await notionChanged(s, p)) {
      running.add(p.id);
      try {
        await syncProject(s, p);
      } catch (e) {
        await projectsOf(s).update(p.id, { syncError: errMsg(e).slice(0, 300) });
      } finally {
        running.delete(p.id);
      }
    }
  }
}

export function reportText(project: Project, r: SyncReport): string {
  const bits = [`${r.pages} сторінок`, r.tables ? `${r.tables} таблиць` : '', r.files ? `${r.files} файлів` : '', r.links ? `${r.links} сайтів` : ''].filter(Boolean);
  return `Проєкт «${project.name}» прочитано: ${bits.join(', ')}.${r.errors.length ? ` Не вдалося: ${r.errors.slice(0, 3).join('; ')}.` : ''}`;
}
