import { DateTime } from 'luxon';
import { findConflicts } from '../calendar/logic.js';
import { errMsg } from '../lib/log.js';
import type { CalEvent } from '../integrations/google-calendar.js';
import type { Task, WaitingItem } from '../notion/repo.js';
import { listAllEvents, type Services } from '../services.js';
import { orderTasks } from './planner.js';

export interface TodayView {
  date: string;
  timezone: string;
  events: Array<Pick<CalEvent, 'id' | 'account' | 'title' | 'start' | 'end' | 'allDay' | 'location' | 'link'>>;
  conflicts: Array<[string, string]>;
  /** due today or overdue, most urgent first */
  focus: Task[];
  /** due in the next 7 days */
  upcoming: Task[];
  waiting: WaitingItem[];
  pending: number;
  errors: Partial<Record<'calendar' | 'tasks' | 'waiting', string>>;
}

/** The web "Сьогодні" screen: same data as the morning report, no model call, partial on errors. */
export async function buildToday(s: Services): Promise<TodayView> {
  const st = await s.settings.get();
  const now = DateTime.fromJSDate(s.clock(), { zone: st.timezone });
  const today = now.toISODate()!;
  const errors: TodayView['errors'] = {};

  let events: CalEvent[] = [];
  try {
    const r = await listAllEvents(s, now.startOf('day').toISO()!, now.endOf('day').toISO()!);
    events = r.events.filter((e) => !e.mirror);
    if (r.errors.length) errors.calendar = r.errors.join('; ');
  } catch (e) {
    errors.calendar = errMsg(e);
  }

  let open: Task[] = [];
  let waiting: WaitingItem[] = [];
  try {
    const notion = await s.notion();
    open = await notion.queryTasks({ open: true, dueOnOrBefore: now.plus({ days: 7 }).toISODate()!, limit: 150 });
    try {
      waiting = await notion.listWaiting();
    } catch (e) {
      errors.waiting = errMsg(e);
    }
  } catch (e) {
    errors.tasks = errMsg(e);
  }

  return {
    date: today,
    timezone: st.timezone,
    events: events.map(({ id, account, title, start, end, allDay, location, link }) => ({ id, account, title, start, end, allDay, location, link })),
    conflicts: findConflicts(events).map(([a, b]) => [a.id, b.id]),
    focus: orderTasks(open.filter((t) => t.due && t.due.slice(0, 10) <= today)),
    upcoming: orderTasks(open.filter((t) => t.due && t.due.slice(0, 10) > today)),
    waiting,
    pending: (await s.pending.listPending()).length,
    errors,
  };
}
