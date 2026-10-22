import { DateTime } from 'luxon';
import { z } from 'zod';
import { runPending, type ActionKind, type ActionPayloads } from '../actions.js';
import { findConflicts } from '../calendar/logic.js';
import type { Account } from '../integrations/google-calendar.js';
import type { ToolSpec } from '../integrations/openai.js';
import { HHMM, parseLocal } from '../lib/time.js';
import { FinanceError, formatSummary, summarize, validateEntry } from '../modules/finance.js';
import { searchEvents, formatEvents } from '../modules/events.js';
import { proposeDayPlan } from '../modules/planner.js';
import { diffTotals, formatSocial, saveSnapshot, snapshotAround } from '../modules/social.js';
import type { SocialData } from '../integrations/social-types.js';
import type { PendingAction } from '../store/pending.js';
import { connectedAccounts, listAllEvents, type Services } from '../services.js';

export interface ToolContext {
  s: Services;
  chatId: number;
  /** pending actions created during this turn: the bot renders them as confirm cards */
  proposals: PendingAction[];
  /** voice mode: the owner's last utterance, checked before a spoken "yes" confirms an action */
  lastUserText?: string;
}

export interface Tool<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: T;
  /** true = only creates a pending action; the real change happens after confirmation */
  proposes: boolean;
  run(args: z.infer<T>, ctx: ToolContext): Promise<unknown>;
}

const date = z.string().describe('Дата YYYY-MM-DD');
const dateTime = z.string().describe('Локальний час YYYY-MM-DDTHH:mm (часовий пояс власника) або дата YYYY-MM-DD');

async function propose<K extends ActionKind>(ctx: ToolContext, kind: K, payload: ActionPayloads[K], summary: string) {
  const p = await ctx.s.pending.create(kind, payload, summary, ctx.chatId);
  ctx.proposals.push(p);
  return {
    status: 'awaiting_confirmation',
    action_id: p.id,
    note: 'Дію підготовлено, власник має підтвердити. НЕ повідомляй, що вона виконана.',
    summary,
  };
}

async function canonicalProject(s: Services, name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const projects = (await s.settings.get()).projects;
  if (!projects.length) return name.trim();
  const hit = projects.find((p) => p.toLowerCase() === name.trim().toLowerCase());
  if (!hit) throw new Error(`Проєкту «${name}» немає. Доступні: ${projects.join(', ')}. Уточніть у користувача.`);
  return hit;
}

/** Date-only stays date-only (Notion all-day due), a time becomes a full ISO datetime with the owner's offset. */
async function normDue(s: Services, due?: string): Promise<string | undefined> {
  if (!due) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const zone = (await s.settings.get()).timezone;
  return parseLocal(due, zone).toISO()!;
}

const toTaskView = (t: { id: string; title: string; project?: string; status: string; due?: string; priority?: string }) => ({
  id: t.id,
  title: t.title,
  project: t.project,
  status: t.status,
  due: t.due,
  priority: t.priority,
});

const accountEnum = z.enum(['work', 'personal']);

export function buildTools(): Tool[] {
  const tools: Tool[] = [];
  const add = <T extends z.ZodType>(t: Tool<T>) => tools.push(t as unknown as Tool);

  add({
    name: 'projects_list',
    description: 'Список проєктів власника.',
    schema: z.object({}),
    proposes: false,
    async run(_a, { s }) {
      const fromSettings = (await s.settings.get()).projects;
      return fromSettings.length ? fromSettings : (await s.notion()).listProjects();
    },
  });

  add({
    name: 'tasks_list',
    description: 'Знайти/переглянути задачі в Notion. Завжди викликай перед зміною чи завершенням, щоб отримати id.',
    schema: z.object({
      project: z.string().optional(),
      text: z.string().optional().describe('частина назви'),
      due_on_or_before: date.optional(),
      include_done: z.boolean().optional(),
    }),
    proposes: false,
    async run(a, { s }) {
      const tasks = await (await s.notion()).queryTasks({
        project: await canonicalProject(s, a.project),
        text: a.text,
        dueOnOrBefore: a.due_on_or_before,
        open: !a.include_done,
        limit: 40,
      });
      return tasks.map(toTaskView);
    },
  });

  add({
    name: 'task_create',
    description: 'Підготувати створення задачі в проєкті. Перед цим перевіряється дубль.',
    schema: z.object({
      title: z.string().min(2),
      project: z.string().optional(),
      due: dateTime.optional(),
      priority: z.string().optional(),
      notes: z.string().optional(),
      allow_duplicate: z.boolean().optional().describe('true лише якщо власник підтвердив, що це окрема задача'),
    }),
    proposes: true,
    async run(a, ctx) {
      const project = await canonicalProject(ctx.s, a.project);
      const notion = await ctx.s.notion();
      if (!a.allow_duplicate) {
        const dup = await notion.findDuplicate(a.title, project);
        if (dup) return { status: 'duplicate', existing: toTaskView(dup), note: 'Схожа відкрита задача вже є. Нову не створено. Запитай, чи оновити наявну.' };
      }
      const due = await normDue(ctx.s, a.due);
      const payload = { title: a.title, project, due, priority: a.priority, notes: a.notes };
      return propose(ctx, 'task.create', payload, `Створити задачу «${a.title}»${project ? ` у проєкті ${project}` : ''}${due ? `, дедлайн ${due.slice(0, 16).replace('T', ' ')}` : ''}`);
    },
  });

  add({
    name: 'task_update',
    description: 'Підготувати зміну задачі (назва, проєкт, дедлайн, пріоритет, нотатки).',
    schema: z.object({
      task_id: z.string(),
      title: z.string().optional(),
      project: z.string().optional(),
      due: dateTime.optional(),
      priority: z.string().optional(),
      notes: z.string().optional(),
    }),
    proposes: true,
    async run(a, ctx) {
      const notion = await ctx.s.notion();
      const t = await notion.getTask(a.task_id);
      const patch = { title: a.title, project: await canonicalProject(ctx.s, a.project), due: await normDue(ctx.s, a.due), priority: a.priority, notes: a.notes };
      const changes = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`);
      if (!changes.length) return { status: 'error', note: 'Нічого змінювати.' };
      return propose(ctx, 'task.update', { id: a.task_id, ...patch, label: t.title }, `Оновити задачу «${t.title}» (${changes.join('; ')})`);
    },
  });

  add({
    name: 'task_complete',
    description: 'Підготувати завершення задачі.',
    schema: z.object({ task_id: z.string() }),
    proposes: true,
    async run(a, ctx) {
      const t = await (await ctx.s.notion()).getTask(a.task_id);
      if (t.done) return { status: 'already_done', note: `Задача «${t.title}» вже завершена.` };
      return propose(ctx, 'task.complete', { id: t.id, label: t.title }, `Завершити задачу «${t.title}»`);
    },
  });

  add({
    name: 'task_reschedule',
    description: 'Підготувати перенесення задачі на іншу дату/час (власник підтвердить).',
    schema: z.object({ task_id: z.string(), new_due: dateTime, duration_min: z.number().int().min(5).max(480).optional() }),
    proposes: true,
    async run(a, ctx) {
      const t = await (await ctx.s.notion()).getTask(a.task_id);
      const due = (await normDue(ctx.s, a.new_due))!;
      let start: string | undefined;
      let end: string | undefined;
      if (due.includes('T')) {
        start = due;
        end = DateTime.fromISO(due, { setZone: true }).plus({ minutes: a.duration_min ?? 45 }).toISO()!;
      }
      return propose(ctx, 'task.reschedule', { id: t.id, label: t.title, due, start, end }, `Перенести «${t.title}» на ${due.slice(0, 16).replace('T', ' ')}`);
    },
  });

  add({
    name: 'decision_log',
    description: 'Підготувати фіксацію рішення/домовленості (з відповідальним і строком).',
    schema: z.object({ title: z.string(), project: z.string().optional(), owner: z.string().optional(), due: date.optional(), details: z.string().optional() }),
    proposes: true,
    async run(a, ctx) {
      const project = await canonicalProject(ctx.s, a.project);
      return propose(
        ctx,
        'decision.log',
        { title: a.title, project, owner: a.owner, due: a.due, text: a.details },
        `Зафіксувати рішення «${a.title}»${project ? ` [${project}]` : ''}${a.owner ? `, відповідальний ${a.owner}` : ''}${a.due ? `, до ${a.due}` : ''}`,
      );
    },
  });

  add({
    name: 'waiting_add',
    description: 'Підготувати запис «очікую відповідь» від людини.',
    schema: z.object({ title: z.string().describe('що очікуємо'), from: z.string().optional(), project: z.string().optional(), due: date.optional() }),
    proposes: true,
    async run(a, ctx) {
      const project = await canonicalProject(ctx.s, a.project);
      return propose(ctx, 'waiting.add', { title: a.title, project, from: a.from, due: a.due }, `Очікую: «${a.title}»${a.from ? ` від ${a.from}` : ''}${a.due ? `, до ${a.due}` : ''}`);
    },
  });

  add({
    name: 'waiting_list',
    description: 'Список очікуваних відповідей (відкриті).',
    schema: z.object({}),
    proposes: false,
    async run(_a, { s }) {
      return (await s.notion()).listWaiting();
    },
  });

  add({
    name: 'waiting_resolve',
    description: 'Підготувати закриття очікування (відповідь отримано). id з waiting_list.',
    schema: z.object({ waiting_id: z.string(), title: z.string() }),
    proposes: true,
    async run(a, ctx) {
      return propose(ctx, 'waiting.resolve', { id: a.waiting_id, label: a.title }, `Закрити очікування «${a.title}»`);
    },
  });

  add({
    name: 'calendar_list',
    description: 'Події з обох календарів за період (без дублів-віддзеркалень).',
    schema: z.object({ from: dateTime, to: dateTime }),
    proposes: false,
    async run(a, { s }) {
      const zone = (await s.settings.get()).timezone;
      const from = parseLocal(a.from, zone);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(a.to) ? parseLocal(a.to, zone).endOf('day') : parseLocal(a.to, zone);
      const r = await listAllEvents(s, from.toISO()!, to.toISO()!);
      return {
        events: r.events.filter((e) => !e.mirror).map((e) => ({ calendar: e.account, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location })),
        errors: r.errors,
      };
    },
  });

  add({
    name: 'calendar_conflicts',
    description: 'Знайти накладки подій у календарях за період.',
    schema: z.object({ from: dateTime, to: dateTime }),
    proposes: false,
    async run(a, { s }) {
      const zone = (await s.settings.get()).timezone;
      const from = parseLocal(a.from, zone);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(a.to) ? parseLocal(a.to, zone).endOf('day') : parseLocal(a.to, zone);
      const r = await listAllEvents(s, from.toISO()!, to.toISO()!);
      return findConflicts(r.events).map(([x, y]) => ({ a: { title: x.title, start: x.start, calendar: x.account }, b: { title: y.title, start: y.start, calendar: y.account } }));
    },
  });

  add({
    name: 'calendar_create',
    description: 'Підготувати створення події в календарі. Автоматично перевіряє конфлікти.',
    schema: z.object({
      title: z.string(),
      start: z.string().describe('YYYY-MM-DDTHH:mm'),
      end: z.string().describe('YYYY-MM-DDTHH:mm'),
      calendar: accountEnum.optional().describe('work (за замовчуванням) або personal'),
      location: z.string().optional(),
      description: z.string().optional(),
    }),
    proposes: true,
    async run(a, ctx) {
      const { s } = ctx;
      const zone = (await s.settings.get()).timezone;
      const start = parseLocal(a.start, zone);
      const end = parseLocal(a.end, zone);
      if (end <= start) return { status: 'error', note: 'Кінець події раніше за початок.' };
      const connected = await connectedAccounts(s);
      const account: Account = a.calendar ?? (connected.includes('work') ? 'work' : (connected[0] ?? 'work'));
      let conflictNote = '';
      const r = await listAllEvents(s, start.toISO()!, end.toISO()!);
      const overlaps = r.events.filter((e) => !e.allDay && e.busy && !e.mirror && new Date(e.start) < end.toJSDate() && new Date(e.end) > start.toJSDate());
      if (overlaps.length) conflictNote = `\n⚠️ Конфлікт: ${overlaps.map((e) => `«${e.title}» ${DateTime.fromISO(e.start, { zone }).toFormat('HH:mm')}–${DateTime.fromISO(e.end, { zone }).toFormat('HH:mm')}`).join(', ')}`;
      const payload = { account, title: a.title, start: start.toISO()!, end: end.toISO()!, description: a.description, location: a.location };
      const res = await propose(ctx, 'calendar.create', payload, `Створити подію «${a.title}» ${start.toFormat('dd.LL HH:mm')}–${end.toFormat('HH:mm')} (${account})${conflictNote}`);
      return { ...res, conflicts: conflictNote ? conflictNote.trim() : undefined };
    },
  });

  add({
    name: 'plan_day',
    description: 'Скласти план дня: розставити відкриті задачі у вільні вікна між зустрічами. Створюється пропозиція, блоки з’являться після підтвердження.',
    schema: z.object({ date: date.optional() }),
    proposes: true,
    async run(a, ctx) {
      const { s } = ctx;
      const settings = await s.settings.get();
      const day = a.date ?? DateTime.fromJSDate(s.clock(), { zone: settings.timezone }).toISODate()!;
      const plan = await proposeDayPlan(s, day);
      if (!plan.blocks.length) return { status: 'empty', plan: plan.text, unplaced: plan.unplaced };
      const res = await propose(ctx, 'plan.apply', { account: settings.planCalendar, blocks: plan.blocks }, `План дня ${day}:\n${plan.text}${plan.unplaced.length ? `\nНе влізли: ${plan.unplaced.join(', ')}` : ''}`);
      return { ...res, plan: plan.text, unplaced: plan.unplaced };
    },
  });

  add({
    name: 'finance_record',
    description: 'Підготувати запис витрати/доходу. amount — додатне число, напрям у kind. Категорія з наданого списку.',
    schema: z.object({
      amount: z.number().positive(),
      currency: z.string().optional(),
      kind: z.enum(['expense', 'income']),
      category: z.string(),
      scope: z.enum(['personal', 'project']).describe('personal = особисте; project = по проєкту'),
      project: z.string().optional(),
      note: z.string().optional(),
      date: date.optional().describe('за замовчуванням сьогодні'),
    }),
    proposes: true,
    async run(a, ctx) {
      const settings = await ctx.s.settings.get();
      const today = DateTime.fromJSDate(ctx.s.clock(), { zone: settings.timezone }).toISODate()!;
      let entry;
      try {
        entry = validateEntry({ ...a, date: a.date ?? today }, settings);
      } catch (e) {
        if (e instanceof FinanceError) return { status: 'error', note: e.message };
        throw e;
      }
      const sign = entry.kind === 'expense' ? '−' : '+';
      return propose(ctx, 'finance.record', entry, `${sign}${entry.amount} ${entry.currency} · ${entry.category} · ${entry.scope === 'personal' ? 'особисте' : entry.project}${entry.note ? ` · ${entry.note}` : ''} (${entry.date})`);
    },
  });

  add({
    name: 'finance_summary',
    description: 'Підсумок витрат/доходів за період. Суми вже пораховані — передай їх користувачу дослівно, не перераховуй.',
    schema: z.object({ from: date, to: date, scope: z.enum(['personal', 'project']).optional(), project: z.string().optional() }),
    proposes: false,
    async run(a, { s }) {
      const entries = await (await s.notion()).queryFinance(a.from, a.to);
      return { text: formatSummary(summarize(entries, { scope: a.scope, project: a.project }), `${a.from} – ${a.to}`) };
    },
  });

  add({
    name: 'social_metrics',
    description: 'Актуальні метрики Instagram та/або YouTube (охоплення, перегляди, залученість, динаміка). Лише читання.',
    schema: z.object({ platform: z.enum(['instagram', 'youtube', 'both']), days: z.number().int().min(1).max(90).optional() }),
    proposes: false,
    async run(a, { s }) {
      const zone = (await s.settings.get()).timezone;
      const day = DateTime.fromJSDate(s.clock(), { zone }).toISODate()!;
      const parts: string[] = [];
      for (const p of a.platform === 'both' ? (['instagram', 'youtube'] as const) : [a.platform]) {
        const client = p === 'instagram' ? s.instagram : s.youtube;
        if (!client) {
          parts.push(`${p}: не підключено`);
          continue;
        }
        try {
          const data: SocialData = await client.snapshot(a.days ?? 7);
          await saveSnapshot(s.db, data, day);
          const prev = await snapshotAround(s.db, p, day, 7);
          parts.push(formatSocial(data, prev && diffTotals(prev, data) ? prev : undefined, 7));
        } catch (e) {
          parts.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { text: parts.join('\n\n') };
    },
  });

  add({
    name: 'events_search',
    description: 'Знайти події/конференції за темами власника просто зараз.',
    schema: z.object({}),
    proposes: false,
    async run(_a, { s }) {
      const settings = await s.settings.get();
      const today = DateTime.fromJSDate(s.clock(), { zone: settings.timezone }).toISODate()!;
      const r = await searchEvents({ db: s.db, llm: s.llm, settings, today });
      return { text: formatEvents(r.fresh) };
    },
  });

  add({
    name: 'note_save',
    description: 'Підготувати збереження тексту (відповідь ChatGPT/Dot, нотатка) у «Матеріали» проєкту.',
    schema: z.object({ title: z.string(), text: z.string(), project: z.string().optional(), source: z.enum(['ChatGPT', 'Dot', 'Інше']).optional() }),
    proposes: true,
    async run(a, ctx) {
      const project = await canonicalProject(ctx.s, a.project);
      return propose(ctx, 'note.save', { title: a.title, project, source: a.source ?? 'Інше', text: a.text }, `Зберегти матеріал «${a.title}»${project ? ` у проєкт ${project}` : ''}`);
    },
  });

  add({
    name: 'settings_set',
    description: 'Змінити налаштування асистента: час звітів, голосові відповіді, календар для планування, теми/географія подій. Виконується одразу.',
    schema: z.object({
      morning_time: z.string().optional().describe('HH:mm'),
      evening_time: z.string().optional().describe('HH:mm'),
      voice_replies: z.enum(['mirror', 'always', 'never']).optional(),
      plan_calendar: accountEnum.optional(),
      events_topics: z.array(z.string()).max(3).optional(),
      events_geo: z.string().optional(),
    }),
    proposes: false,
    async run(a, { s }) {
      for (const t of [a.morning_time, a.evening_time]) if (t && !HHMM.test(t)) return { status: 'error', note: `Невірний формат часу: ${t} (потрібно HH:mm)` };
      const patch = {
        ...(a.morning_time ? { morningTime: a.morning_time } : {}),
        ...(a.evening_time ? { eveningTime: a.evening_time } : {}),
        ...(a.voice_replies ? { voiceReplies: a.voice_replies } : {}),
        ...(a.plan_calendar ? { planCalendar: a.plan_calendar } : {}),
        ...(a.events_topics ? { eventsTopics: a.events_topics } : {}),
        ...(a.events_geo !== undefined ? { eventsGeo: a.events_geo } : {}),
      };
      if (!Object.keys(patch).length) return { status: 'error', note: 'Нічого змінювати.' };
      const next = await s.settings.update(patch);
      return { status: 'applied', morning: next.morningTime, evening: next.eveningTime, voice: next.voiceReplies, plan_calendar: next.planCalendar };
    },
  });

  add({
    name: 'memory_save',
    description:
      'Запам’ятати надовго факт про людей, проєкти чи вподобання власника (хто є хто, як звертатися, що любить/не любить, звички). Виконується одразу. Не зберігай паролі, номери карток і документів.',
    schema: z.object({
      subject: z.string().min(1).describe('про кого/що: «Олена», «кава», «звіти»'),
      content: z.string().min(2).describe('сам факт одним реченням'),
      kind: z.enum(['person', 'preference', 'fact']).optional(),
    }),
    proposes: false,
    async run(a, { s }) {
      if (/\b\d{12,19}\b|парол|password|cvv|паспорт/i.test(`${a.subject} ${a.content}`)) return { status: 'refused', note: 'Чутливі дані не зберігаю.' };
      const r = await s.memory.remember(a.subject, a.content, a.kind ?? 'fact');
      return { status: r.updated ? 'updated' : 'saved', id: r.memory.id };
    },
  });

  add({
    name: 'memory_search',
    description: 'Знайти в довгій пам’яті, що відомо про людину чи тему.',
    schema: z.object({ query: z.string().min(1) }),
    proposes: false,
    async run(a, { s }) {
      return (await s.memory.search(a.query)).map((m) => ({ id: m.id, subject: m.subject, content: m.content }));
    },
  });

  add({
    name: 'memory_forget',
    description: 'Забути запис пам’яті на прохання власника (id з memory_search).',
    schema: z.object({ id: z.number().int() }),
    proposes: false,
    async run(a, { s }) {
      return { status: (await s.memory.forget(a.id)) ? 'forgotten' : 'not_found' };
    },
  });

  return tools;
}

const YES = /(^|[^\p{L}])(так|да|ага|ок|окей|добре|гаразд|підтверджую|підтверджуй|підтверди|давай|роби|вперед|звісно|авжеж|tak|da|ok|okay|yes|sure)([^\p{L}]|$)/iu;
const NO = /(^|[^\p{L}])(ні|нет|не треба|не потрібно|скасуй|відміни|стоп|ni|niet|no)([^\p{L}]|$)/iu;

/** Did the owner actually say "yes" (and not "no")? A model call alone never confirms anything. */
export function isSpokenYes(text: string | undefined): boolean {
  return Boolean(text && YES.test(text) && !NO.test(text));
}

/** Voice mode has no buttons: the owner confirms out loud and the model calls these. */
export function buildVoiceTools(): Tool[] {
  const tools = buildTools();
  const confirm: Tool<z.ZodObject<{ action_id: z.ZodString }>> = {
    name: 'pending_confirm',
    description: 'Виконати підготовлену дію ПІСЛЯ того, як власник щойно вголос сказав «так»/«підтверджую». action_id з результату інструмента.',
    schema: z.object({ action_id: z.string() }),
    proposes: false,
    async run(a, ctx) {
      if (!isSpokenYes(ctx.lastUserText)) return { status: 'not_confirmed', note: 'Власник не сказав «так». Запитай підтвердження ще раз.' };
      const r = await runPending(ctx.s, a.action_id);
      if (r.claimed) await ctx.s.messages.add(ctx.chatId, 'assistant', `${r.ok ? 'Підтверджено голосом і виконано' : 'Помилка виконання'}: ${r.text}`);
      return { status: r.ok ? 'done' : 'failed', result: r.text };
    },
  };
  const cancel: Tool<z.ZodObject<{ action_id: z.ZodString }>> = {
    name: 'pending_cancel',
    description: 'Скасувати підготовлену дію, якщо власник відмовився.',
    schema: z.object({ action_id: z.string() }),
    proposes: false,
    async run(a, ctx) {
      return { status: (await ctx.s.pending.cancel(a.action_id)) ? 'cancelled' : 'already_handled' };
    },
  };
  return [...tools, confirm as unknown as Tool, cancel as unknown as Tool];
}

export function toolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(t.schema, { target: 'draft-7' }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}
