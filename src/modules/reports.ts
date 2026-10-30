import { DateTime } from 'luxon';
import { blocking, findConflicts } from '../calendar/logic.js';
import { fmtTime } from '../lib/time.js';
import { errMsg } from '../lib/log.js';
import type { CalEvent } from '../integrations/google-calendar.js';
import type { SocialData } from '../integrations/social-types.js';
import type { Task } from '../notion/repo.js';
import { esc, listAllEvents, type Services } from '../services.js';
import { orderTasks } from './planner.js';
import { calm, dueLabel, groupedTasks, heading, NUM, quote, RULE, Sections, shortTitle, taskItem, title } from './report-format.js';
import { diffTotals, LABELS } from './social.js';

const none = calm('немає');

/** A failing source degrades one section, never the whole report. */
async function section<R extends string | undefined>(fallbackHtml: (e: string) => string, fn: () => Promise<R>): Promise<R | string> {
  try {
    return await fn();
  } catch (e) {
    return fallbackHtml(esc(errMsg(e)));
  }
}
const warn = (e: string) => `⚠️ <i>не вдалось отримати: ${e}</i>`;

function eventLine(e: CalEvent, zone: string): string {
  if (e.allDay) return `<b>весь день</b>  ${esc(e.title)}`;
  const s = DateTime.fromISO(e.start, { zone });
  const en = DateTime.fromISO(e.end, { zone });
  return `<b>${fmtTime(s)}–${fmtTime(en)}</b>  ${esc(e.title)}${e.location ? ` <i>· ${esc(e.location)}</i>` : ''}`;
}

interface Picks {
  priorities: string[];
  prep: Array<{ event: string; note: string }>;
}

/** The model only ranks and comments; ids are checked against real tasks so nothing is invented. */
async function pickPriorities(s: Services, tasks: Task[], events: CalEvent[]): Promise<Picks> {
  const fallback: Picks = { priorities: orderTasks(tasks).slice(0, 3).map((t) => t.id), prep: [] };
  if (!tasks.length && !events.length) return fallback;
  try {
    const res = await s.llm.chat({
      json: true,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'Ти асистент керівника. З переліку задач обери до 3 найважливіших на сьогодні (за дедлайном, пріоритетом, впливом). ' +
            'Для кожної зустрічі, де потрібна підготовка, дай одну коротку нотатку (що підготувати), спираючись лише на наведені задачі. ' +
            'Відповідай JSON: {"priorities":["<task id>",...],"prep":[{"event":"<назва>","note":"<1 речення українською>"}]}. Не вигадуй id.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            tasks: tasks.slice(0, 40).map((t) => ({ id: t.id, title: t.title, project: t.project, due: t.due, priority: t.priority })),
            meetings: events.filter((e) => !e.allDay).map((e) => ({ title: e.title, start: e.start })),
          }),
        },
      ],
    });
    const parsed = JSON.parse(res.content ?? '{}') as Partial<Picks>;
    const valid = (parsed.priorities ?? []).filter((id) => tasks.some((t) => t.id === id)).slice(0, 3);
    return {
      priorities: valid.length ? valid : fallback.priorities,
      prep: (parsed.prep ?? []).filter((p) => p && typeof p.event === 'string' && typeof p.note === 'string').slice(0, 5),
    };
  } catch {
    return fallback;
  }
}

async function socialLine(s: Services, day: string): Promise<string | undefined> {
  const lines: string[] = [];
  for (const platform of ['instagram', 'youtube'] as const) {
    const { rows } = await s.db.query<{ data: SocialData }>(
      `SELECT data FROM social_snapshots WHERE platform = $1 ORDER BY taken_on DESC LIMIT 1`,
      [platform],
    );
    const cur = rows[0]?.data;
    if (!cur) continue;
    const prev = await s.db.query<{ data: SocialData }>(
      `SELECT data FROM social_snapshots WHERE platform = $1 AND taken_on <= ($2::date - 7) ORDER BY taken_on DESC LIMIT 1`,
      [platform, day],
    );
    const delta = diffTotals(prev.rows[0]?.data, cur);
    const key = platform === 'instagram' ? 'followers' : 'subscribers';
    const d = delta[key];
    lines.push(`${platform === 'instagram' ? 'Instagram' : 'YouTube'}: ${LABELS[key]} <b>${cur.totals[key] ?? '—'}</b>${d ? ` (${d > 0 ? '+' : ''}${d} за 7 дн.)` : ''}`);
  }
  return lines.length ? quote(lines) : undefined;
}

export async function buildMorningReport(s: Services): Promise<string> {
  const settings = await s.settings.get();
  const zone = settings.timezone;
  const now = DateTime.fromJSDate(s.clock(), { zone });
  const today = now.toISODate()!;
  const notion = await s.notion();

  let events: CalEvent[] = [];
  let calendarError: string | undefined;
  try {
    const r = await listAllEvents(s, now.startOf('day').toISO()!, now.endOf('day').toISO()!);
    events = r.events.filter((e) => !e.mirror);
    if (r.errors.length) calendarError = r.errors.join('; ');
  } catch (e) {
    calendarError = errMsg(e);
  }

  let open: Task[] = [];
  let tasksError: string | undefined;
  try {
    open = await notion.queryTasks({ open: true, dueOnOrBefore: now.plus({ days: 3 }).toISODate()!, limit: 100 });
  } catch (e) {
    tasksError = errMsg(e);
  }
  const todays = open.filter((t) => !t.due || t.due.slice(0, 10) <= today);
  const upcoming = orderTasks(open.filter((t) => t.due && t.due.slice(0, 10) > today));
  const picks = await pickPriorities(s, todays, events);
  const top = picks.priorities.map((id) => todays.find((t) => t.id === id)!).filter(Boolean);
  const extra = orderTasks(todays.filter((t) => !picks.priorities.includes(t.id)));
  const meetings = blocking(events);
  const overdue = todays.filter((t) => t.due && t.due.slice(0, 10) < today).length;

  const glance = [
    `🗓 ${meetings.length ? `зустрічей: <b>${meetings.length}</b>` : 'без зустрічей'}`,
    `📌 задач: <b>${todays.length}</b>`,
    ...(overdue ? [`⏱ прострочено: <b>${overdue}</b>`] : []),
  ].join('   ');
  const out = new Sections();
  out.raw(title('☀️', 'Доброго ранку!', now) + '\n' + glance);
  out.raw(RULE);

  const prepFor = (e: CalEvent) => picks.prep.find((p) => e.title.toLowerCase().includes(p.event.toLowerCase()) || p.event.toLowerCase().includes(e.title.toLowerCase()));
  const conflicts = findConflicts(events);
  out.add(
    heading('🗓', 'Графік дня', events.length),
    calendarError && !events.length
      ? warn(esc(calendarError))
      : (events.length ? quote(events.map((e) => eventLine(e, zone))) : calm('День вільний від зустрічей')) +
          (conflicts.length ? '\n⚠️ <b>Конфлікти:</b> ' + conflicts.map(([a, b]) => `«${esc(a.title)}» ↔ «${esc(b.title)}»`).join('; ') : ''),
  );
  out.add(
    heading('⭐', 'Три головні пріоритети'),
    tasksError ? warn(esc(tasksError)) : top.length ? top.map((t, i) => `${NUM[i]} ${taskItem(t, today, zone, { project: true })}`).join('\n') : none,
  );
  out.maybe(heading('➕', 'Додаткові задачі', extra.length), 'додаткові задачі', tasksError ? warn(esc(tasksError)) : extra.length ? groupedTasks(extra, today, zone, 10) : undefined);
  // the schedule already lists every meeting: here only the ones that need preparation
  const prep = meetings.map((e) => ({ e, note: prepFor(e) })).filter((x) => x.note);
  out.maybe(
    heading('🤝', 'Зустрічі та підготовка'),
    'підготовка до зустрічей',
    prep.length ? quote(prep.map(({ e, note }) => `${eventLine(e, zone)}\n↳ <i>${esc(note!.note)}</i>`)) : undefined,
  );
  out.maybe(
    heading('⏳', 'Очікую відповіді'),
    'очікування',
    await section(warn, async () => {
      const w = await notion.listWaiting();
      if (!w.length) return undefined;
      return quote(
        w.map((x) => {
          const due = dueLabel(x.due, today, zone);
          return `${esc(shortTitle(x))}${x.from ? ` — <b>${esc(x.from)}</b>` : ''}${due ? `  <i>${due}</i>` : ''}`;
        }),
        w.length > 5,
      );
    }),
  );
  out.maybe(
    heading('⏰', 'Дедлайни найближчих днів', upcoming.length),
    'дедлайни',
    tasksError ? warn(esc(tasksError)) : upcoming.length ? quote(upcoming.slice(0, 8).map((t) => `◦ ${taskItem(t, today, zone, { project: true })}`), upcoming.length > 5) : undefined,
  );
  out.maybe(heading('📈', 'Соцмережі'), 'соцмережі', await section(warn, () => socialLine(s, today)));
  return out.html(calm(top.length ? 'Почни з першого пункту — решта зачекає. Гарного дня ✨' : 'Гарного дня ✨'));
}

export async function buildEveningReport(s: Services): Promise<string> {
  const settings = await s.settings.get();
  const zone = settings.timezone;
  const now = DateTime.fromJSDate(s.clock(), { zone });
  const today = now.toISODate()!;
  const tomorrow = now.plus({ days: 1 }).toISODate()!;
  const notion = await s.notion();

  let done: Task[] = [];
  let doneError: string | undefined;
  try {
    done = await notion.queryTasks({ doneSince: now.startOf('day').toISO()! });
  } catch (e) {
    doneError = errMsg(e);
  }

  let open: Task[] = [];
  let openError: string | undefined;
  try {
    open = await notion.queryTasks({ open: true, dueOnOrBefore: tomorrow, limit: 100 });
  } catch (e) {
    openError = errMsg(e);
  }
  const unfinished = orderTasks(open.filter((t) => t.due && t.due.slice(0, 10) <= today));
  const overdue = unfinished.filter((t) => t.due!.slice(0, 10) < today).length;

  let tomorrowEvents = 0;
  try {
    const t0 = now.plus({ days: 1 }).startOf('day');
    const r = await listAllEvents(s, t0.toISO()!, t0.endOf('day').toISO()!);
    tomorrowEvents = blocking(r.events).length;
  } catch {
    /* calendar is optional for this section */
  }

  const glance = [`✅ закрито: <b>${done.length}</b>`, `⏳ відкрито: <b>${unfinished.length}</b>`, ...(overdue ? [`⏱ прострочено: <b>${overdue}</b>`] : [])].join('   ');
  const out = new Sections();
  out.raw(title('🌙', 'Підсумок дня', now) + '\n' + glance);
  out.raw(RULE);

  out.add(
    heading('✅', 'Завершено сьогодні', done.length),
    doneError ? warn(esc(doneError)) : done.length ? quote(done.map((t) => `✓ ${esc(shortTitle(t))}${t.project ? ` <i>· ${esc(t.project)}</i>` : ''}`), done.length > 6) : calm('Сьогодні без закритих задач — буває.'),
  );
  out.add(heading('⏳', 'Не завершено', unfinished.length), openError ? warn(esc(openError)) : unfinished.length ? groupedTasks(unfinished, today, zone) : calm('Все, що було на сьогодні, закрито 🎉'));
  out.maybe(
    heading('🧾', 'Нові рішення та домовленості'),
    'нові рішення',
    await section(warn, async () => {
      const d = await notion.listDecisionsSince(now.startOf('day').toISO()!);
      if (!d.length) return undefined;
      return quote(
        d.map((x) => {
          const due = dueLabel(x.due, today, zone);
          return `${esc(shortTitle(x))}${x.project ? ` <i>· ${esc(x.project)}</i>` : ''}${x.owner ? ` — <b>${esc(x.owner)}</b>` : ''}${due ? `  <i>${due}</i>` : ''}`;
        }),
      );
    }),
  );

  const tomorrowTasks = orderTasks(open.filter((t) => !t.due || t.due.slice(0, 10) <= tomorrow)).slice(0, 3);
  out.add(
    heading('🎯', 'Пріоритети на завтра'),
    (openError ? warn(esc(openError)) : tomorrowTasks.length ? tomorrowTasks.map((t, i) => `${NUM[i]} ${taskItem(t, today, zone, { project: true })}`).join('\n') : none) +
      (tomorrowEvents ? `\n🗓 <i>Зустрічей завтра: ${tomorrowEvents}</i>` : ''),
  );
  return out.html(calm('Відпочивай — завтра продовжимо 🌿'));
}
