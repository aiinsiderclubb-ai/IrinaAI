import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { findConflicts, freeSlots, planDay, reconcileMirrors, BUSY_TITLE } from '../src/calendar/logic.js';
import { syncCalendars } from '../src/calendar/sync.js';
import type { CalEvent } from '../src/integrations/google-calendar.js';
import { makeEnv } from './helpers/services.js';

const ev = (id: string, start: string, end: string, extra: Partial<CalEvent> = {}): CalEvent => ({
  id, account: 'work', title: id, start, end, allDay: false, busy: true, mirror: false, cancelled: false, ...extra,
});
const t = (hhmm: string) => new Date(`2026-10-23T${hhmm}:00+03:00`).getTime();

describe('conflicts', () => {
  it('finds overlaps across calendars, ignores touching, all-day, free and mirror events', () => {
    const events = [
      ev('a', '2026-10-23T10:00:00+03:00', '2026-10-23T11:00:00+03:00'),
      ev('b', '2026-10-23T10:30:00+03:00', '2026-10-23T11:30:00+03:00', { account: 'personal' }),
      ev('c', '2026-10-23T11:30:00+03:00', '2026-10-23T12:00:00+03:00'), // touches b
      ev('d', '2026-10-23', '2026-10-24', { allDay: true }),
      ev('e', '2026-10-23T10:15:00+03:00', '2026-10-23T10:45:00+03:00', { busy: false }),
      ev('f', '2026-10-23T10:15:00+03:00', '2026-10-23T10:45:00+03:00', { mirror: true }),
    ];
    const pairs = findConflicts(events).map(([x, y]) => `${x.id}-${y.id}`);
    expect(pairs).toEqual(['a-b']);
  });
});

describe('free slots and day plan', () => {
  const events = [
    ev('m1', '2026-10-23T10:00:00+03:00', '2026-10-23T11:00:00+03:00'),
    ev('m2', '2026-10-23T10:30:00+03:00', '2026-10-23T12:00:00+03:00', { account: 'personal' }),
    ev('mirror', '2026-10-23T14:00:00+03:00', '2026-10-23T15:00:00+03:00', { mirror: true }),
  ];
  it('merges overlapping busy time and respects minimum length', () => {
    const slots = freeSlots(events, t('09:00'), t('18:00'), 30);
    expect(slots.map((s) => [new Date(s.start).toISOString().slice(11, 16), new Date(s.end).toISOString().slice(11, 16)])).toEqual([
      ['06:00', '07:00'], // 09:00-10:00 local
      ['09:00', '11:00'], // 12:00-14:00 local
      ['12:00', '15:00'], // 15:00-18:00 local
    ]);
  });
  it('places urgent tasks first and reports what does not fit', () => {
    const slots = freeSlots(events, t('09:00'), t('12:30'), 20);
    const plan = planDay(
      [
        { id: 'late', title: 'Later', priorityRank: 1, due: '2026-10-25', estimateMin: 30 },
        { id: 'urgent', title: 'Urgent', priorityRank: 0, due: '2026-10-23', estimateMin: 50 },
        { id: 'huge', title: 'Huge', priorityRank: 1, due: '2026-10-24', estimateMin: 240 },
      ],
      slots,
      { bufferMin: 10 },
    );
    expect(plan.blocks[0]).toMatchObject({ taskId: 'urgent', start: t('09:00') });
    expect(plan.blocks.map((b) => b.taskId)).toEqual(['urgent', 'late']);
    expect(plan.unplaced.map((x) => x.id)).toEqual(['huge']);
    for (const b of plan.blocks) expect(slots.some((s) => b.start >= s.start && b.end <= s.end)).toBe(true);
  });
});

describe('mirror reconcile', () => {
  const win = t('00:00');
  it('creates, updates, deletes and recreates', () => {
    const src = [ev('a', '2026-10-23T10:00:00+03:00', '2026-10-23T11:00:00+03:00'), ev('b', '2026-10-23T12:00:00+03:00', '2026-10-23T13:00:00+03:00')];
    const first = reconcileMirrors({ sources: src, rows: [], dstEventIds: new Set(), windowStart: win, details: false });
    expect(first.map((o) => o.type)).toEqual(['create', 'create']);
    if (first[0]!.type === 'create') expect(first[0]!.payload.title).toBe(BUSY_TITLE);

    const rows = first.map((o, i) => ({ srcEventId: (o as any).src.id, dstEventId: `d${i}`, startAt: t('10:00'), fingerprint: (o as any).fingerprint }));
    const same = reconcileMirrors({ sources: src, rows, dstEventIds: new Set(['d0', 'd1']), windowStart: win, details: false });
    expect(same).toEqual([]);

    const moved = [ev('a', '2026-10-23T10:30:00+03:00', '2026-10-23T11:30:00+03:00'), src[1]!];
    expect(reconcileMirrors({ sources: moved, rows, dstEventIds: new Set(['d0', 'd1']), windowStart: win, details: false }).map((o) => o.type)).toEqual(['update']);
    expect(reconcileMirrors({ sources: [src[0]!], rows, dstEventIds: new Set(['d0', 'd1']), windowStart: win, details: false }).map((o) => o.type)).toEqual(['delete']);
    const gone = reconcileMirrors({ sources: src, rows, dstEventIds: new Set(['d1']), windowStart: win, details: false });
    expect(gone.map((o) => o.type)).toEqual(['create']);
    expect((gone[0] as any).replacing.dstEventId).toBe('d0');
  });
});

describe('syncCalendars (two-way, no ping-pong)', () => {
  it('mirrors both ways, is stable on re-run, follows edits and deletions', async () => {
    const env = await makeEnv();
    const run = () => syncCalendars({ db: env.db, calendar: env.calendar, clock: env.s.clock, timeZone: 'Europe/Kyiv', details: false });
    const w = env.calendar.add('work', { title: 'Board meeting', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T11:00:00+03:00' });
    env.calendar.add('personal', { title: 'Dentist', start: '2026-10-23T15:00:00+03:00', end: '2026-10-23T16:00:00+03:00' });

    expect(await run()).toEqual({ created: 2, updated: 0, deleted: 0 });
    expect(env.calendar.events.personal.filter((e) => e.mirror).map((e) => e.title)).toEqual(['Зайнято']);
    expect(env.calendar.events.work.filter((e) => e.mirror).map((e) => e.title)).toEqual(['Зайнято']);

    expect(await run()).toEqual({ created: 0, updated: 0, deleted: 0 }); // mirrors are not mirrored back

    w.start = '2026-10-23T10:30:00+03:00';
    expect(await run()).toMatchObject({ updated: 1, created: 0 });
    expect(env.calendar.events.personal.find((e) => e.mirror)!.start).toBe('2026-10-23T10:30:00+03:00');

    env.calendar.events.work = env.calendar.events.work.filter((e) => e.id !== w.id);
    expect(await run()).toMatchObject({ deleted: 1 });
    expect(env.calendar.events.personal.filter((e) => e.mirror)).toHaveLength(0);

    // someone deleted a mirror by hand: it comes back
    env.calendar.events.work = env.calendar.events.work.filter((e) => !e.mirror);
    expect(await run()).toMatchObject({ created: 1 });
  });

  it('shows real titles when mirrorDetails is on', async () => {
    const env = await makeEnv();
    env.calendar.add('work', { title: 'Board meeting', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T11:00:00+03:00' });
    await syncCalendars({ db: env.db, calendar: env.calendar, clock: env.s.clock, timeZone: 'Europe/Kyiv', details: true });
    expect(env.calendar.events.personal[0]!.title).toBe('Board meeting');
    void DateTime;
  });
});
