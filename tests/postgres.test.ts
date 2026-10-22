import { describe, expect, it } from 'vitest';
import { runPending } from '../src/actions.js';
import { Agent } from '../src/agent/agent.js';
import { syncCalendars } from '../src/calendar/sync.js';
import { createPgDb } from '../src/db/index.js';
import { claimJob } from '../src/scheduler.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

/** Same code paths on a real Postgres (the `pg` driver differs from PGlite in type parsing). Run with TEST_DATABASE_URL. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('real Postgres', () => {
  it('migrates, runs the confirm flow, claims jobs and mirrors calendars', async () => {
    const db = createPgDb(process.env.TEST_DATABASE_URL!);
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const env = await makeEnv({ db });

    env.llm.script.push(toolCall('task_create', { title: 'Задача на PG', project: 'Alpha', due: '2026-10-24' }), say('ok'));
    const reply = await new Agent(env.s).handle(42, 'додай');
    expect((await runPending(env.s, reply.proposals[0]!.id)).ok).toBe(true);
    expect((await runPending(env.s, reply.proposals[0]!.id)).ok).toBe(false);
    expect(env.notion.titles('tasks')).toEqual(['Задача на PG']);

    expect(await claimJob(db, 'job', 'p')).toBe(1);
    expect(await claimJob(db, 'job', 'p')).toBeUndefined();

    env.calendar.add('work', { title: 'Нарада', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T11:00:00+03:00' });
    const run = () => syncCalendars({ db, calendar: env.calendar, clock: env.s.clock, timeZone: 'Europe/Kyiv', details: false });
    expect(await run()).toEqual({ created: 1, updated: 0, deleted: 0 });
    expect(await run()).toEqual({ created: 0, updated: 0, deleted: 0 });

    expect((await env.s.settings.get()).projects).toEqual(['Alpha', 'Beta']);
    expect((await env.s.tokens.get('google:work'))?.refreshToken).toBe('r1');
    await db.close();
  });
});
