import { DateTime } from 'luxon';
import type { Db } from './db/index.js';
import { syncCalendars } from './calendar/sync.js';
import { GoogleAuthError } from './integrations/google-auth.js';
import { errMsg } from './lib/log.js';
import { atTime } from './lib/time.js';
import { formatEvents, searchEvents } from './modules/events.js';
import { runNudges } from './modules/nudges.js';
import { buildEveningReport, buildMorningReport } from './modules/reports.js';
import { saveSnapshot } from './modules/social.js';
import { connectedAccounts, esc, type Services } from './services.js';
import type { Settings } from './store/settings.js';

export interface Job {
  name: string;
  /** period key when the job should run now (one run per key), otherwise undefined */
  due(now: DateTime, st: Settings): string | undefined;
  run(s: Services): Promise<void>;
}

/** Runs once per day in the window [at, at + windowH) local time, so a restart does not lose it. */
function daily(at: (st: Settings) => string, windowH: number) {
  return (now: DateTime, st: Settings): string | undefined => {
    const start = atTime(now, at(st));
    return now >= start && now < start.plus({ hours: windowH }) ? now.toISODate()! : undefined;
  };
}

/**
 * Idempotent claim: only one instance wins a (job, period). Failed runs are retried up to 3 times (2 min apart),
 * a run stuck in `running` for 10 min is taken over. Safe with overlapping deploys.
 */
export async function claimJob(db: Db, job: string, period: string): Promise<number | undefined> {
  const { rows } = await db.query<{ attempts: number }>(
    `INSERT INTO job_runs(job, period, status, attempts, updated_at) VALUES ($1,$2,'running',1,now())
     ON CONFLICT (job, period) DO UPDATE SET status = 'running', attempts = job_runs.attempts + 1, updated_at = now()
     WHERE (job_runs.status = 'failed' AND job_runs.attempts < 3 AND job_runs.updated_at < now() - interval '2 minutes')
        OR (job_runs.status = 'running' AND job_runs.updated_at < now() - interval '10 minutes')
     RETURNING attempts`,
    [job, period],
  );
  return rows[0]?.attempts;
}

async function finishJob(db: Db, job: string, period: string, error?: string): Promise<void> {
  await db.query(`UPDATE job_runs SET status = $3, error = $4, updated_at = now() WHERE job = $1 AND period = $2`, [
    job,
    period,
    error ? 'failed' : 'done',
    error ?? null,
  ]);
}

export function buildJobs(): Job[] {
  return [
    {
      name: 'morning_report',
      due: daily((st) => st.morningTime, 2),
      run: async (s) => s.notify(await buildMorningReport(s)),
    },
    {
      name: 'evening_report',
      due: daily((st) => st.eveningTime, 2),
      run: async (s) => s.notify(await buildEveningReport(s)),
    },
    {
      name: 'events_weekly',
      due: (now, st) => {
        if (!st.eventsTopics.length || now.weekday !== st.eventsWeekday) return undefined;
        const start = atTime(now, st.eventsTime);
        return now >= start && now < start.plus({ hours: 3 }) ? `${now.weekYear}-W${now.weekNumber}` : undefined;
      },
      run: async (s) => {
        const st = await s.settings.get();
        const today = DateTime.fromJSDate(s.clock(), { zone: st.timezone }).toISODate()!;
        const r = await searchEvents({ db: s.db, llm: s.llm, settings: st, today });
        await s.notify(esc(formatEvents(r.fresh)));
      },
    },
    {
      // proactive: meeting soon, reply overdue, deadline today. Web picks them up from the table.
      name: 'nudges',
      due: (now) => String(Math.floor(now.toMillis() / 60_000)),
      run: async (s) => {
        for (const n of await runNudges(s)) await s.notify(`🔔 ${esc(n.text)}`);
      },
    },
    {
      name: 'calendar_sync',
      due: (now) => String(Math.floor(now.toMillis() / 300_000)),
      run: async (s) => {
        const accounts = await connectedAccounts(s);
        if (!s.calendar || accounts.length < 2) return;
        const st = await s.settings.get();
        await syncCalendars({ db: s.db, calendar: s.calendar, clock: s.clock, timeZone: st.timezone, details: st.mirrorDetails, log: s.log });
      },
    },
    {
      name: 'social_snapshot',
      due: daily(() => '03:00', 6),
      run: async (s) => {
        const day = DateTime.fromJSDate(s.clock(), { zone: (await s.settings.get()).timezone }).toISODate()!;
        const errors: string[] = [];
        for (const [name, client] of [['Instagram', s.instagram], ['YouTube', s.youtube]] as const) {
          if (!client) continue;
          const slot = name === 'Instagram' ? 'instagram' : 'google:youtube';
          if (!(await s.tokens.connected()).includes(slot)) continue;
          try {
            await saveSnapshot(s.db, await client.snapshot(7), day);
          } catch (e) {
            errors.push(`${name}: ${errMsg(e)}`);
          }
        }
        if (errors.length) throw new Error(errors.join('; '));
      },
    },
    {
      name: 'token_health',
      due: daily(() => '04:00', 6),
      run: async (s) => {
        const problems: string[] = [];
        if (s.instagram && (await s.tokens.connected()).includes('instagram')) {
          try {
            const exp = await s.instagram.refreshToken();
            if (exp && exp.getTime() - s.clock().getTime() < 7 * 86400_000) problems.push('Токен Instagram спливає менш ніж за 7 днів. Виконайте /connect.');
          } catch (e) {
            problems.push(`Токен Instagram не оновився (${errMsg(e)}). Виконайте /connect.`);
          }
        }
        for (const slot of ['google:work', 'google:personal', 'google:youtube'] as const) {
          const t = await s.tokens.get(slot);
          if (!t) continue;
          if (t.meta.broken) {
            problems.push(`Доступ ${slot} втрачено. Виконайте /connect.`);
            continue;
          }
          try {
            await s.googleAuth?.accessToken(slot);
          } catch (e) {
            if (e instanceof GoogleAuthError) problems.push(e.message + '. Виконайте /connect.');
          }
        }
        if (problems.length) await s.notify('⚠️ <b>Потрібна увага</b>\n' + problems.map((p) => `• ${esc(p)}`).join('\n'));
      },
    },
    {
      name: 'housekeeping',
      due: daily(() => '05:00', 6),
      run: async (s) => {
        await s.messages.prune(30);
        await s.pending.expireOlderThan(48);
        await s.db.query(`DELETE FROM job_runs WHERE updated_at < now() - interval '14 days'`);
        await s.db.query(`DELETE FROM nudges WHERE created_at < now() - interval '30 days'`);
      },
    },
  ];
}

/** One scheduler pass. Returns the names of the jobs it ran. */
export async function tick(s: Services, jobs: Job[] = buildJobs()): Promise<string[]> {
  const st = await s.settings.get();
  const now = DateTime.fromJSDate(s.clock(), { zone: st.timezone });
  const ran: string[] = [];
  for (const job of jobs) {
    const period = job.due(now, st);
    if (!period) continue;
    const attempt = await claimJob(s.db, job.name, period);
    if (!attempt) continue;
    try {
      await job.run(s);
      await finishJob(s.db, job.name, period);
      ran.push(job.name);
    } catch (e) {
      const msg = errMsg(e);
      s.log.error('job_failed', { job: job.name, attempt, error: msg.slice(0, 300) });
      await finishJob(s.db, job.name, period, msg.slice(0, 500));
      if (attempt >= 3 && job.name !== 'calendar_sync' && job.name !== 'nudges') {
        await s.notify(`⚠️ Не вдалося виконати «${esc(job.name)}»: ${esc(msg.slice(0, 200))}`).catch(() => {});
      }
    }
  }
  return ran;
}

export function startScheduler(s: Services, everyMs = 30_000): () => void {
  const jobs = buildJobs();
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(s, jobs);
    } catch (e) {
      s.log.error('tick_failed', { error: errMsg(e).slice(0, 300) });
    } finally {
      running = false;
    }
  }, everyMs);
  return () => clearInterval(timer);
}
