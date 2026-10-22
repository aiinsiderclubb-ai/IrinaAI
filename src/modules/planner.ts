import { DateTime } from 'luxon';
import { freeSlots, planDay, type PlanBlock, type PlanTask } from '../calendar/logic.js';
import { atTime, fmtTime } from '../lib/time.js';
import type { Task } from '../notion/repo.js';
import { listAllEvents, type Services } from '../services.js';

export function priorityRank(p?: string): number {
  const v = (p ?? '').toLowerCase();
  if (/high|висок|терм|urgent|срочн|важлив|p1|🔴/.test(v)) return 0;
  if (/low|низьк|низк|p3|🟢/.test(v)) return 2;
  return 1;
}

export const toPlanTask = (t: Task): PlanTask => ({ id: t.id, title: t.title, priorityRank: priorityRank(t.priority), due: t.due });

/** Tasks in the order they should be tackled: due date first, then priority. */
export function orderTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title),
  );
}

export interface DayPlanProposal {
  day: string;
  blocks: Array<{ taskId: string; title: string; start: string; end: string }>;
  unplaced: string[];
  text: string;
}

/** Fits the day's open tasks into the free time between meetings. Nothing is written until the owner confirms. */
export async function proposeDayPlan(s: Services, dayISO: string): Promise<DayPlanProposal> {
  const settings = await s.settings.get();
  const zone = settings.timezone;
  const day = DateTime.fromISO(dayISO, { zone });
  let from = atTime(day, settings.workdayStart);
  const to = atTime(day, settings.workdayEnd);
  const now = DateTime.fromJSDate(s.clock(), { zone });
  if (now > from && now.hasSame(day, 'day')) from = now.plus({ minutes: 5 - (now.minute % 5) }).startOf('minute');
  if (from >= to) throw new Error('Робочий день уже закінчився.');

  const { events } = await listAllEvents(s, from.startOf('day').toISO()!, to.endOf('day').toISO()!);
  const slots = freeSlots(events, from.toMillis(), to.toMillis(), 20);
  const notion = await s.notion();
  const tasks = orderTasks(await notion.queryTasks({ open: true, dueOnOrBefore: dayISO, limit: 30 }));
  const planned = planDay(tasks.map(toPlanTask), slots);

  const blocks = planned.blocks.map((b: PlanBlock) => ({
    taskId: b.taskId,
    title: b.title,
    start: DateTime.fromMillis(b.start, { zone }).toISO()!,
    end: DateTime.fromMillis(b.end, { zone }).toISO()!,
  }));
  const lines = blocks.map((b) => `${fmtTime(DateTime.fromISO(b.start, { zone }))}–${fmtTime(DateTime.fromISO(b.end, { zone }))}  ${b.title}`);
  const text = lines.length ? lines.join('\n') : 'Вільних вікон для задач немає.';
  return { day: dayISO, blocks, unplaced: planned.unplaced.map((t) => t.title), text };
}
