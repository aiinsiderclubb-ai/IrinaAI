import { z } from 'zod';
import type { LlmMessage } from '../integrations/openai.js';
import { errMsg } from '../lib/log.js';
import { activeProject, projectsOf } from '../projects/index.js';
import type { Services } from '../services.js';
import { buildSystemPrompt, runToolCall } from './agent.js';
import { tell } from './project-tools.js';
import { buildTools, toolSpecs, type Tool, type ToolContext } from './tools.js';

const MAX_STEPS = 45;
const MAX_MS = 25 * 60_000;
const PROGRESS_EVERY_MS = 60_000;
/** past this much text in the conversation, old tool results are shortened */
const MAX_CONTEXT_CHARS = 160_000;

/** What a background job may use: reading, searching, opening sites, preparing table changes. Nothing is changed without the owner. */
const JOB_TOOLS = new Set([
  'web_search',
  'web_open',
  'project_search',
  'material_read',
  'material_save',
  'project_folders',
  'notion_page_read',
  'notion_table_read',
  'notion_table_create',
  'notion_table_rows',
  'notion_page_create',
  'memory_search',
  'tasks_list',
]);

const JOB_RULES = [
  'ТИ ПРАЦЮЄШ У ФОНІ над великим дорученням власниці. Вона не чекає в чаті: не став їй запитань — роби найкраще з того, що є, а все незрозуміле винось у підсумок.',
  'ПОРЯДОК:',
  '1) Спершу прочитай ТЗ і матеріали проєкту (project_search, material_read, notion_page_read) і випиши для себе критерії.',
  '2) Шукай кандидатів через web_search кількома різними запитами (різні формулювання, країни, мови, де доречно).',
  '3) Відкривай їхні сайти web_open (до 6 за раз), за потреби — сторінки контактів і каталогу з key_links. Перевіряй можливості, обсяги, сертифікати, умови, контакти.',
  '4) Кожні кілька кроків коротко звітуй через job_progress: що зроблено, скільки кандидатів, що далі (1–2 речення).',
  '5) Результати в таблицю: якщо в проєкті є відповідна таблиця — notion_table_read, потім ОДНА пачка notion_table_rows з усіма кандидатами. Якщо таблиці немає — notion_table_create з потрібними колонками і одразу з рядками (rows). ' +
    'У колонці джерела — посилання, звідки факт. Невідоме лишай порожнім, не вигадуй.',
  '6) Фінальна відповідь (Markdown для Telegram, без вступу): коротко що зроблено; порівняння кандидатів; кому писати першими і чому (топ-3); яких умов бракує для рішення — запитання до них; ' +
    'чернетки листів першим кандидатам (мовою, доречною для країни виробника), стисло. Наприкінці — що потребує рішення власниці.',
  'Факти — лише з відкритих сторінок і матеріалів, з посиланнями. Таблиці й документи створюються лише після підтвердження власниці — пиши «підготувала», а не «створила».',
].join('\n');

interface JobRow {
  id: number;
  chat_id: number;
  project_id: number | null;
  goal: string;
  status: string;
}

const cancelled = new Set<number>();

/** Shortens old tool results so a long job does not drown in its own history. */
function compact(messages: LlmMessage[]): void {
  let total = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  if (total <= MAX_CONTEXT_CHARS) return;
  const keepFrom = messages.length - 8;
  for (let i = 2; i < keepFrom && total > MAX_CONTEXT_CHARS * 0.7; i++) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.content.length > 700) {
      total -= m.content.length - 600;
      m.content = `${m.content.slice(0, 600)}…(скорочено; повний текст — у матеріалах)`;
    }
  }
}

export async function runningJob(s: Services): Promise<JobRow | undefined> {
  const { rows } = await s.db.query<JobRow>("SELECT * FROM agent_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), chat_id: Number(rows[0].chat_id) } : undefined;
}

/** Runs one job to the end: its own agent loop with a bigger step budget, progress messages, cards and a report. */
export async function runJob(s: Services, job: JobRow): Promise<void> {
  const progress = (note: string) => s.db.query('UPDATE agent_jobs SET progress = $2, updated_at = now() WHERE id = $1', [job.id, note.slice(0, 1000)]);
  let lastProgress = 0;
  const jobTool: Tool = {
    name: 'job_progress',
    description: 'Коротко повідомити власниці хід роботи (1–2 речення): що зроблено, скільки знайдено, що далі.',
    schema: z.object({ note: z.string().min(3).max(500) }),
    proposes: false,
    async run(a: { note: string }) {
      await progress(a.note);
      if (Date.now() - lastProgress < PROGRESS_EVERY_MS) return { status: 'saved', note: 'Збережено; повідомлення не надсилаю — минулого разу писала щойно.' };
      lastProgress = Date.now();
      await tell(s, job.chat_id, `⏳ ${a.note}`);
      return { status: 'sent' };
    },
  };
  const tools = [...buildTools().filter((t) => JOB_TOOLS.has(t.name)), jobTool];
  const specs = toolSpecs(tools);
  const ctx: ToolContext = { s, chatId: job.chat_id, proposals: [] };
  const messages: LlmMessage[] = [
    { role: 'system', content: `${await buildSystemPrompt(s, 'text')}\n\n${JOB_RULES}` },
    { role: 'user', content: `Доручення: ${job.goal}` },
  ];
  const started = Date.now();
  let final = '';
  let steps = 0;
  for (; steps < MAX_STEPS; steps++) {
    if (cancelled.has(job.id)) break;
    const outOfTime = Date.now() - started > MAX_MS || steps === MAX_STEPS - 1;
    if (outOfTime) messages.push({ role: 'user', content: 'Час на доручення вичерпано. Без інструментів підсумуй зібране зараз за правилом 6.' });
    const res = await s.llm.chat({ messages, tools: outOfTime ? undefined : specs, temperature: 0.3 });
    if (!res.toolCalls.length || outOfTime) {
      final = (res.content ?? '').trim();
      break;
    }
    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls, raw: res.raw });
    for (const call of res.toolCalls) {
      const out = await runToolCall(tools, call.name, call.arguments, ctx);
      messages.push({ role: 'tool', toolCallId: call.id, content: out.slice(0, 9000) });
    }
    await s.db.query('UPDATE agent_jobs SET steps = $2, updated_at = now() WHERE id = $1', [job.id, steps + 1]);
    compact(messages);
  }

  if (cancelled.has(job.id)) {
    cancelled.delete(job.id);
    await s.db.query("UPDATE agent_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1", [job.id]);
    await tell(s, job.chat_id, 'Фонове доручення зупинено.');
    return;
  }
  if (job.project_id && final) {
    await projectsOf(s).addMaterial({ projectId: job.project_id, kind: 'report', title: `Звіт: ${job.goal.slice(0, 120)}`, text: final, meta: { job: job.id } });
  }
  await s.db.query("UPDATE agent_jobs SET status = 'done', result = $2, steps = $3, finished_at = now(), updated_at = now() WHERE id = $1", [job.id, final, steps]);
  await tell(s, job.chat_id, final ? `✅ ${final}` : '✅ Доручення завершено, але підсумку модель не дала — спитай мене, що вдалося знайти.');
  for (const p of ctx.proposals) await s.deliver?.card(job.chat_id, p);
  if (ctx.proposals.length) await s.messages.add(job.chat_id, 'assistant', `(фонове доручення підготувало дій на підтвердження: ${ctx.proposals.length})`);
  if (final) await s.messages.add(job.chat_id, 'assistant', final.slice(0, 4000));
}

/** Starts a job in the background; one at a time. */
export async function startJob(s: Services, chatId: number, goal: string): Promise<{ id: number } | { busy: string }> {
  const busy = await runningJob(s);
  if (busy) return { busy: busy.goal };
  const project = await activeProject(s);
  const { rows } = await s.db.query<{ id: string }>('INSERT INTO agent_jobs(chat_id, project_id, goal) VALUES ($1,$2,$3) RETURNING id', [chatId, project?.id ?? null, goal]);
  const job: JobRow = { id: Number(rows[0]!.id), chat_id: chatId, project_id: project?.id ?? null, goal, status: 'running' };
  void runJob(s, job).catch(async (e) => {
    s.log.error('job_failed', { job: job.id, error: errMsg(e).slice(0, 300) });
    await s.db.query("UPDATE agent_jobs SET status = 'failed', result = $2, finished_at = now(), updated_at = now() WHERE id = $1", [job.id, errMsg(e).slice(0, 1000)]);
    await tell(s, chatId, `Фонове доручення зупинилось через помилку: ${errMsg(e).slice(0, 200)}. Напиши «продовжуй», і я спробую ще раз.`).catch(() => {});
  });
  return { id: job.id };
}

/** After a restart: jobs that were running are lost; tell the owner once. */
export async function recoverJobs(s: Services): Promise<void> {
  const { rows } = await s.db.query<JobRow>("UPDATE agent_jobs SET status = 'failed', result = 'перервано перезапуском сервера', finished_at = now() WHERE status = 'running' RETURNING *");
  for (const j of rows) {
    await tell(s, Number(j.chat_id), `Фонове доручення «${j.goal.slice(0, 120)}» перервалося через перезапуск сервера. Напиши «запусти знову», і я продовжу.`).catch(() => {});
  }
}

export function jobTools(): Tool[] {
  return [
    {
      name: 'background_start',
      description:
        'Запустити ВЕЛИКЕ доручення у фоні (10–20 хв, до 45 кроків): напр. «знайди виробників за ТЗ, перевір їхні сайти, занеси в таблицю, порівняй і підготуй листи». ' +
        'Асистент сам читає матеріали проєкту, шукає, відкриває сайти, звітує про хід і наприкінці надсилає підсумок і картки на підтвердження. ' +
        'goal — повне доручення з усіма побажаннями власниці (критерії, кількість, країни, що на виході).',
      schema: z.object({ goal: z.string().min(10).max(4000) }),
      proposes: false,
      async run(a: { goal: string }, ctx: ToolContext) {
        const r = await startJob(ctx.s, ctx.chatId, a.goal);
        if ('busy' in r) return { status: 'busy', note: `Уже виконується інше доручення: «${r.busy.slice(0, 200)}». Дочекайся або зупини через background_status cancel=true.` };
        return { status: 'started', job_id: r.id, note: 'Запущено у фоні. Скажи коротко, що взялась, звітуватимеш про хід і пришлеш підсумок (зазвичай 10–20 хв).' };
      },
    } as Tool,
    {
      name: 'background_status',
      description: 'Стан фонових доручень (останні 5): що виконується, хід роботи. cancel=true — зупинити поточне.',
      schema: z.object({ cancel: z.boolean().optional() }),
      proposes: false,
      async run(a: { cancel?: boolean }, ctx: ToolContext) {
        const cur = await runningJob(ctx.s);
        if (a.cancel && cur) {
          cancelled.add(cur.id);
          return { status: 'cancelling', job: cur.goal.slice(0, 200) };
        }
        const { rows } = await ctx.s.db.query('SELECT id, goal, status, progress, steps, created_at FROM agent_jobs ORDER BY id DESC LIMIT 5');
        return { jobs: rows.map((r: any) => ({ id: Number(r.id), goal: String(r.goal).slice(0, 200), status: r.status, progress: r.progress, steps: r.steps })) };
      },
    } as Tool,
  ];
}
