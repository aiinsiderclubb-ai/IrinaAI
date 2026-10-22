import { DateTime } from 'luxon';
import { blocking, findConflicts } from '../calendar/logic.js';
import { fmtDate, fmtTime } from '../lib/time.js';
import { errMsg } from '../lib/log.js';
import type { CalEvent } from '../integrations/google-calendar.js';
import type { SocialData } from '../integrations/social-types.js';
import type { Task } from '../notion/repo.js';
import { esc, listAllEvents, type Services } from '../services.js';
import { orderTasks } from './planner.js';
import { diffTotals, LABELS } from './social.js';

const dueShort = (t: Task) => (t.due ? ` <i>(до ${esc(t.due.slice(0, 10))})</i>` : '');
const taskLine = (t: Task) => `• ${esc(t.title)}${t.project ? ` [${esc(t.project)}]` : ''}${dueShort(t)}`;
const none = '<i>немає</i>';

/** A failing source degrades one section, never the whole report. */
async function section<T>(fallbackHtml: (e: string) => string, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return fallbackHtml(esc(errMsg(e)));
  }
}
const warn = (e: string) => `⚠️ <i>не вдалось отримати: ${e}</i>`;

function eventLine(e: CalEvent, zone: string): string {
  if (e.allDay) return `• весь день — ${esc(e.title)}`;
  const s = DateTime.fromISO(e.start, { zone });
  const en = DateTime.fromISO(e.end, { zone });
  return `• ${fmtTime(s)}–${fmtTime(en)} ${esc(e.title)}${e.location ? ` (${esc(e.location)})` : ''}`;
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

async function socialLine(s: Services, day: string): Promise<string> {
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
    lines.push(`• ${platform === 'instagram' ? 'Instagram' : 'YouTube'}: ${LABELS[key]} ${cur.totals[key] ?? '—'}${d ? ` (${d > 0 ? '+' : ''}${d} за 7 дн.)` : ''}`);
  }
  return lines.length ? lines.join('\n') : none;
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

  const parts: string[] = [`<b>☀️ Доброго ранку! ${esc(fmtDate(now))}</b>`];

  parts.push(
    '<b>🗓 Графік дня</b>\n' +
      (calendarError && !events.length
        ? warn(esc(calendarError))
        : (events.length ? events.map((e) => eventLine(e, zone)).join('\n') : none) +
          (() => {
            const c = findConflicts(events);
            return c.length ? '\n⚠️ <b>Конфлікти:</b> ' + c.map(([a, b]) => `«${esc(a.title)}» ↔ «${esc(b.title)}»`).join('; ') : '';
          })()),
  );
  parts.push('<b>⭐ Три головні пріоритети</b>\n' + (tasksError ? warn(esc(tasksError)) : top.length ? top.map(taskLine).join('\n') : none));
  parts.push('<b>➕ Додаткові задачі</b>\n' + (tasksError ? warn(esc(tasksError)) : extra.length ? extra.slice(0, 8).map(taskLine).join('\n') + (extra.length > 8 ? `\n… ще ${extra.length - 8}` : '') : none));
  parts.push(
    '<b>🤝 Зустрічі та підготовка</b>\n' +
      (() => {
        const meetings = blocking(events);
        if (!meetings.length) return none;
        return meetings
          .map((e) => {
            const note = picks.prep.find((p) => e.title.toLowerCase().includes(p.event.toLowerCase()) || p.event.toLowerCase().includes(e.title.toLowerCase()));
            return eventLine(e, zone) + (note ? `\n   ↳ ${esc(note.note)}` : '');
          })
          .join('\n');
      })(),
  );
  parts.push(
    '<b>⏳ Очікую відповіді</b>\n' +
      (await section(warn, async () => {
        const w = await notion.listWaiting();
        return w.length ? w.map((x) => `• ${esc(x.title)}${x.from ? ` — ${esc(x.from)}` : ''}${x.due ? ` <i>(до ${esc(x.due.slice(0, 10))})</i>` : ''}`).join('\n') : none;
      })),
  );
  parts.push('<b>⏰ Дедлайни найближчих днів</b>\n' + (tasksError ? warn(esc(tasksError)) : upcoming.length ? upcoming.slice(0, 8).map(taskLine).join('\n') : none));
  parts.push('<b>📈 Соцмережі</b>\n' + (await section(warn, () => socialLine(s, today))));
  return parts.join('\n\n');
}

export async function buildEveningReport(s: Services): Promise<string> {
  const settings = await s.settings.get();
  const zone = settings.timezone;
  const now = DateTime.fromJSDate(s.clock(), { zone });
  const today = now.toISODate()!;
  const tomorrow = now.plus({ days: 1 }).toISODate()!;
  const notion = await s.notion();

  const parts: string[] = [`<b>🌙 Підсумок дня, ${esc(fmtDate(now))}</b>`];

  parts.push(
    '<b>✅ Завершено сьогодні</b>\n' +
      (await section(warn, async () => {
        const done = await notion.queryTasks({ doneSince: now.startOf('day').toISO()! });
        return done.length ? done.map((t) => `• ${esc(t.title)}${t.project ? ` [${esc(t.project)}]` : ''}`).join('\n') : none;
      })),
  );

  let open: Task[] = [];
  let openError: string | undefined;
  try {
    open = await notion.queryTasks({ open: true, dueOnOrBefore: tomorrow, limit: 100 });
  } catch (e) {
    openError = errMsg(e);
  }
  const unfinished = open.filter((t) => t.due && t.due.slice(0, 10) <= today);
  parts.push('<b>⏳ Не завершено</b>\n' + (openError ? warn(esc(openError)) : unfinished.length ? orderTasks(unfinished).map(taskLine).join('\n') : none));

  parts.push(
    '<b>🧾 Нові рішення та домовленості</b>\n' +
      (await section(warn, async () => {
        const d = await notion.listDecisionsSince(now.startOf('day').toISO()!);
        return d.length
          ? d.map((x) => `• ${esc(x.title)}${x.project ? ` [${esc(x.project)}]` : ''}${x.owner ? ` — ${esc(x.owner)}` : ''}${x.due ? ` <i>(до ${esc(x.due.slice(0, 10))})</i>` : ''}`).join('\n')
          : none;
      })),
  );

  const tomorrowTasks = orderTasks(open.filter((t) => !t.due || t.due.slice(0, 10) <= tomorrow));
  let tomorrowEvents = 0;
  try {
    const t0 = now.plus({ days: 1 }).startOf('day');
    const r = await listAllEvents(s, t0.toISO()!, t0.endOf('day').toISO()!);
    tomorrowEvents = blocking(r.events).length;
  } catch {
    /* calendar is optional for this section */
  }
  parts.push(
    '<b>🎯 Пріоритети на завтра</b>\n' +
      (openError ? warn(esc(openError)) : tomorrowTasks.length ? tomorrowTasks.slice(0, 5).map(taskLine).join('\n') : none) +
      (tomorrowEvents ? `\n<i>Зустрічей у календарі: ${tomorrowEvents}</i>` : ''),
  );
  return parts.join('\n\n');
}
