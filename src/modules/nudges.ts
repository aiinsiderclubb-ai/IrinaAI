import { DateTime } from 'luxon';
import { blocking } from '../calendar/logic.js';
import type { CalEvent } from '../integrations/google-calendar.js';
import { errMsg } from '../lib/log.js';
import type { Task, WaitingItem } from '../notion/repo.js';
import { listAllEvents, type Services } from '../services.js';

export interface Nudge {
  key: string;
  text: string;
}

const MEETING_LEAD_MIN = 15;
/** After this hour overdue replies are worth a reminder (once a day each). */
const WAITING_AFTER = 10;
/** After this hour, today's unfinished deadlines get one reminder. */
const DEADLINE_AFTER = 16;

/** Pure: what is worth saying right now. Keys make each thing said once (per day for recurring ones). */
export function computeNudges(input: { now: DateTime; events: CalEvent[]; openTasks: Task[]; waiting: WaitingItem[] }): Nudge[] {
  const { now, events, openTasks, waiting } = input;
  const today = now.toISODate()!;
  const out: Nudge[] = [];

  for (const e of blocking(events)) {
    const start = DateTime.fromISO(e.start).setZone(now.zone);
    const mins = Math.round(start.diff(now, 'minutes').minutes);
    if (mins <= 0 || mins > MEETING_LEAD_MIN) continue;
    const isFocusBlock = e.title.startsWith('🎯');
    const text = isFocusBlock
      ? `Через ${mins} хв фокус-блок: ${e.title.replace(/^🎯\s*/, '')}.`
      : `Через ${mins} хв — «${e.title}»${e.location ? ` (${e.location})` : ''}.`;
    out.push({ key: `meet:${e.account}:${e.id}:${e.start}`, text });
  }

  if (now.hour >= WAITING_AFTER) {
    for (const w of waiting) {
      if (!w.due || w.due.slice(0, 10) >= today) continue;
      out.push({ key: `wait:${w.id}:${today}`, text: `«${w.title}»${w.from ? ` від ${w.from}` : ''} досі без відповіді (чекали до ${w.due.slice(0, 10)}). Нагадати чи перенести?` });
    }
  }

  if (now.hour >= DEADLINE_AFTER) {
    const due = openTasks.filter((t) => t.due?.slice(0, 10) === today);
    if (due.length) {
      const list = due.slice(0, 3).map((t) => `«${t.title}»`).join(', ');
      out.push({ key: `due:${today}`, text: `Сьогодні дедлайн і ще не закрито: ${list}${due.length > 3 ? ` і ще ${due.length - 3}` : ''}. Встигаємо чи переносимо?` });
    }
  }
  return out;
}

/** Collects data, stores new nudges (idempotent by key) and returns only the new ones. */
export async function runNudges(s: Services): Promise<Nudge[]> {
  const st = await s.settings.get();
  const now = DateTime.fromJSDate(s.clock(), { zone: st.timezone });
  let events: CalEvent[] = [];
  let openTasks: Task[] = [];
  let waiting: WaitingItem[] = [];
  try {
    events = (await listAllEvents(s, now.toISO()!, now.plus({ minutes: MEETING_LEAD_MIN + 1 }).toISO()!)).events;
  } catch (e) {
    s.log.warn('nudges_calendar', { error: errMsg(e).slice(0, 120) });
  }
  try {
    const notion = await s.notion();
    if (now.hour >= DEADLINE_AFTER) openTasks = await notion.queryTasks({ open: true, dueOn: now.toISODate()!, limit: 50 });
    if (now.hour >= WAITING_AFTER) waiting = await notion.listWaiting();
  } catch (e) {
    s.log.warn('nudges_notion', { error: errMsg(e).slice(0, 120) });
  }
  const fresh: Nudge[] = [];
  for (const n of computeNudges({ now, events, openTasks, waiting })) {
    const { rows } = await s.db.query('INSERT INTO nudges(key, text) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key', [n.key, n.text]);
    if (rows.length) fresh.push(n);
  }
  return fresh;
}

export async function nudgesAfter(s: Services, afterIso: string | undefined): Promise<Array<{ key: string; text: string; createdAt: string }>> {
  const after = afterIso && !Number.isNaN(Date.parse(afterIso)) ? afterIso : new Date(s.clock().getTime() - 15 * 60_000).toISOString();
  const { rows } = await s.db.query<{ key: string; text: string; created_at: Date }>(
    'SELECT key, text, created_at FROM nudges WHERE created_at > $1 ORDER BY created_at LIMIT 20',
    [after],
  );
  return rows.map((r) => ({ key: r.key, text: r.text, createdAt: new Date(r.created_at).toISOString() }));
}
