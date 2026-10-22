import { createHash } from 'node:crypto';
import type { Account, CalEvent } from '../integrations/google-calendar.js';

export interface Interval {
  start: number;
  end: number;
}

const ms = (iso: string) => new Date(iso).getTime();

/** Timed, busy, real events: what can conflict with something else. */
export function blocking(events: CalEvent[]): CalEvent[] {
  return events.filter((e) => !e.allDay && e.busy && !e.cancelled && !e.mirror);
}

/** Pairs of overlapping events (across both calendars). Touching ends do not conflict. */
export function findConflicts(events: CalEvent[]): Array<[CalEvent, CalEvent]> {
  const list = blocking(events).sort((a, b) => ms(a.start) - ms(b.start));
  const out: Array<[CalEvent, CalEvent]> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (ms(b.start) >= ms(a.end)) break;
      out.push([a, b]);
    }
  }
  return out;
}

/** Free gaps of at least `minMinutes` inside [from, to]. Mirrors count as busy: they stand for the other calendar. */
export function freeSlots(events: CalEvent[], from: number, to: number, minMinutes: number): Interval[] {
  const busy = events
    .filter((e) => !e.allDay && e.busy && !e.cancelled)
    .map((e) => ({ start: Math.max(ms(e.start), from), end: Math.min(ms(e.end), to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const i of busy) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  const slots: Interval[] = [];
  let cursor = from;
  for (const b of merged) {
    if (b.start - cursor >= minMinutes * 60_000) slots.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= minMinutes * 60_000) slots.push({ start: cursor, end: to });
  return slots;
}

export interface PlanTask {
  id: string;
  title: string;
  estimateMin?: number;
  /** lower = more important */
  priorityRank: number;
  due?: string;
}

export interface PlanBlock {
  taskId: string;
  title: string;
  start: number;
  end: number;
}

/** Greedy day plan: most urgent first, each task into the first slot that fits, with a buffer between blocks. */
export function planDay(
  tasks: PlanTask[],
  slots: Interval[],
  opts: { defaultEstimateMin?: number; bufferMin?: number } = {},
): { blocks: PlanBlock[]; unplaced: PlanTask[] } {
  const def = opts.defaultEstimateMin ?? 45;
  const buffer = (opts.bufferMin ?? 10) * 60_000;
  const free = slots.map((s) => ({ ...s }));
  const order = [...tasks].sort(
    (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.priorityRank - b.priorityRank || a.title.localeCompare(b.title),
  );
  const blocks: PlanBlock[] = [];
  const unplaced: PlanTask[] = [];
  for (const t of order) {
    const len = (t.estimateMin ?? def) * 60_000;
    const slot = free.find((s) => s.end - s.start >= len);
    if (!slot) {
      unplaced.push(t);
      continue;
    }
    blocks.push({ taskId: t.id, title: t.title, start: slot.start, end: slot.start + len });
    slot.start += len + buffer;
  }
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, unplaced };
}

// ---------- work <-> personal mirror ----------

export interface MirrorRow {
  srcEventId: string;
  dstEventId: string;
  startAt: number;
  fingerprint: string;
}

export interface MirrorPayload {
  title: string;
  start: string;
  end: string;
}

export type MirrorOp =
  | { type: 'create'; src: CalEvent; payload: MirrorPayload; fingerprint: string; replacing?: MirrorRow }
  | { type: 'update'; src: CalEvent; row: MirrorRow; payload: MirrorPayload; fingerprint: string }
  | { type: 'delete'; row: MirrorRow };

export const BUSY_TITLE = 'Зайнято';

export function fingerprintOf(e: CalEvent, details: boolean): string {
  return createHash('sha1').update([details ? e.title : '', e.start, e.end].join('|')).digest('hex').slice(0, 16);
}

/**
 * Diff of one direction (src calendar -> dst calendar).
 * @param sources  events currently in the src window (mirrors included; they are filtered out here)
 * @param rows     existing mirror rows for this direction
 * @param dstEventIds ids of mirror events that really exist in dst right now
 */
export function reconcileMirrors(opts: {
  sources: CalEvent[];
  rows: MirrorRow[];
  dstEventIds: Set<string>;
  windowStart: number;
  details: boolean;
}): MirrorOp[] {
  const { sources, rows, dstEventIds, windowStart, details } = opts;
  const real = blocking(sources);
  const byRow = new Map(rows.map((r) => [r.srcEventId, r]));
  const ops: MirrorOp[] = [];
  const seen = new Set<string>();

  for (const src of real) {
    seen.add(src.id);
    const fp = fingerprintOf(src, details);
    const payload: MirrorPayload = { title: details ? src.title : BUSY_TITLE, start: src.start, end: src.end };
    const row = byRow.get(src.id);
    if (!row) ops.push({ type: 'create', src, payload, fingerprint: fp });
    else if (!dstEventIds.has(row.dstEventId)) ops.push({ type: 'create', src, payload, fingerprint: fp, replacing: row });
    else if (row.fingerprint !== fp) ops.push({ type: 'update', src, row, payload, fingerprint: fp });
  }
  for (const row of rows) {
    if (!seen.has(row.srcEventId) && row.startAt >= windowStart) ops.push({ type: 'delete', row });
  }
  return ops;
}

export function otherAccount(a: Account): Account {
  return a === 'work' ? 'personal' : 'work';
}
