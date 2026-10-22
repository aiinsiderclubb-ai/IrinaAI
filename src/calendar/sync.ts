import { DateTime } from 'luxon';
import type { Db } from '../db/index.js';
import { HttpError } from '../lib/http.js';
import type { Logger } from '../lib/log.js';
import type { Clock } from '../lib/time.js';
import type { Account, CalendarPort } from '../integrations/google-calendar.js';
import { ACCOUNTS } from '../integrations/google-calendar.js';
import { otherAccount, reconcileMirrors, type MirrorRow } from './logic.js';

const WINDOW_BACK_DAYS = 1;
const WINDOW_FWD_DAYS = 60;

const ignore404 = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpError && (e.status === 404 || e.status === 410))) throw e;
  }
};

export interface MirrorStats {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Two-way mirror: every timed busy event of one calendar appears in the other as a block
 * ("Зайнято" by default). Mirrors are tagged and never mirrored back, so there is no ping-pong.
 * Reconciles a window on every run, so it does not depend on webhooks or sync tokens.
 */
export async function syncCalendars(deps: {
  db: Db;
  calendar: CalendarPort;
  clock: Clock;
  timeZone: string;
  details: boolean;
  log?: Logger;
}): Promise<MirrorStats> {
  const { db, calendar, clock, timeZone, details } = deps;
  const now = DateTime.fromJSDate(clock(), { zone: timeZone });
  const from = now.minus({ days: WINDOW_BACK_DAYS }).startOf('day');
  const to = now.plus({ days: WINDOW_FWD_DAYS });
  const events = Object.fromEntries(
    await Promise.all(ACCOUNTS.map(async (a) => [a, await calendar.list(a, from.toISO()!, to.toISO()!)] as const)),
  ) as Record<Account, Awaited<ReturnType<CalendarPort['list']>>>;

  const stats: MirrorStats = { created: 0, updated: 0, deleted: 0 };

  for (const src of ACCOUNTS) {
    const dst = otherAccount(src);
    const { rows } = await db.query(
      'SELECT src_event_id, dst_event_id, start_at, fingerprint FROM event_mirrors WHERE src_account = $1 AND dst_account = $2',
      [src, dst],
    );
    const mirrorRows: MirrorRow[] = rows.map((r) => ({
      srcEventId: r.src_event_id,
      dstEventId: r.dst_event_id,
      startAt: new Date(r.start_at).getTime(),
      fingerprint: r.fingerprint,
    }));
    const dstIds = new Set(events[dst].filter((e) => e.mirror).map((e) => e.id));
    const ops = reconcileMirrors({
      sources: events[src],
      rows: mirrorRows,
      dstEventIds: dstIds,
      windowStart: from.toMillis(),
      details,
    });

    for (const op of ops) {
      if (op.type === 'create') {
        const created = await calendar.create(dst, { ...op.payload, timeZone, mirror: true });
        await db.query(
          `INSERT INTO event_mirrors(src_account, src_event_id, dst_account, dst_event_id, start_at, fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (src_account, src_event_id) DO UPDATE SET dst_event_id = EXCLUDED.dst_event_id,
             start_at = EXCLUDED.start_at, fingerprint = EXCLUDED.fingerprint`,
          [src, op.src.id, dst, created.id, new Date(op.src.start), op.fingerprint],
        );
        stats.created++;
      } else if (op.type === 'update') {
        await ignore404(calendar.patch(dst, op.row.dstEventId, { ...op.payload, timeZone }));
        await db.query('UPDATE event_mirrors SET fingerprint = $3, start_at = $4 WHERE src_account = $1 AND src_event_id = $2', [
          src,
          op.src.id,
          op.fingerprint,
          new Date(op.src.start),
        ]);
        stats.updated++;
      } else {
        await ignore404(calendar.remove(dst, op.row.dstEventId));
        await db.query('DELETE FROM event_mirrors WHERE src_account = $1 AND src_event_id = $2', [src, op.row.srcEventId]);
        stats.deleted++;
      }
    }
  }
  deps.log?.info('calendar_sync', { ...stats });
  return stats;
}
