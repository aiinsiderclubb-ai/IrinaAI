import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent } from '../src/agent/agent.js';
import { buildServer } from '../src/server.js';
import { registerWeb } from '../src/web/api.js';
import { createLoginToken, issueSession, SESSION_COOKIE } from '../src/web/auth.js';
import { makeEnv, say, toolCall, type TestEnv } from './helpers/services.js';

const H = { 'x-requested-with': 'aia' };

async function setup(opts: Parameters<typeof makeEnv>[0] & { password?: string } = {}): Promise<{ env: TestEnv; app: FastifyInstance; cookie: string }> {
  const env = await makeEnv(opts);
  if (opts.password) (env.s.cfg as { WEB_PASSWORD?: string }).WEB_PASSWORD = opts.password;
  const app = buildServer(env.s, {} as never);
  await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false });
  const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, env.s.cfg.OWNER_TELEGRAM_ID, env.s.clock().getTime())}`;
  return { env, app, cookie };
}

describe('web auth', () => {
  it('rejects requests without a session, accepts a valid one, rejects a forged one', async () => {
    const { app, cookie, env } = await setup();
    expect((await app.inject('/api/today')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/today', headers: { cookie: `${SESSION_COOKIE}=forged.sig` } })).statusCode).toBe(401);
    const otherOwner = issueSession(env.s.cfg.APP_SECRET, 999);
    expect((await app.inject({ url: '/api/today', headers: { cookie: `${SESSION_COOKIE}=${otherOwner}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/today', headers: { cookie } })).statusCode).toBe(200);
  });

  it('one-time link from the bot logs in exactly once', async () => {
    const { app, env } = await setup();
    const token = await createLoginToken(env.db);
    const first = await app.inject({ method: 'POST', url: '/api/auth/magic', headers: H, payload: { token } });
    expect(first.statusCode).toBe(200);
    const set = String(first.headers['set-cookie']);
    expect(set).toContain(`${SESSION_COOKIE}=`);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect((await app.inject({ method: 'POST', url: '/api/auth/magic', headers: H, payload: { token } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/magic', headers: H, payload: { token: 'guess' } })).statusCode).toBe(401);
    const cookie = set.split(';')[0]!;
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json()).toMatchObject({ authenticated: true });
  });

  it('expired link does not work', async () => {
    const { app, env } = await setup();
    const token = await createLoginToken(env.db, 10);
    await env.db.query(`UPDATE web_login_tokens SET expires_at = now() - interval '1 minute'`);
    expect((await app.inject({ method: 'POST', url: '/api/auth/magic', headers: H, payload: { token } })).statusCode).toBe(401);
  });

  it('password login with brute-force limit; off when no password is configured', async () => {
    const off = await setup();
    expect((await off.app.inject({ method: 'POST', url: '/api/auth/password', headers: H, payload: { password: 'x' } })).statusCode).toBe(404);

    const { app } = await setup({ password: 'correct-horse-battery' });
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: H, payload: { password: 'correct-horse-battery' } })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: H, payload: { password: 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: H, payload: { password: 'correct-horse-battery' } })).statusCode).toBe(429);
  });

  it('mutating requests without the custom header are refused (CSRF)', async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { text: 'hi' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(403);
  });
});

describe('web assistant', () => {
  it('chat shares the agent and the confirmation gate with Telegram', async () => {
    const { app, cookie, env } = await setup();
    env.llm.script.push(toolCall('task_create', { title: 'Задача з вебу', project: 'Alpha' }), say('Підтвердьте.'));
    const r = (await app.inject({ method: 'POST', url: '/api/chat', headers: { ...H, cookie }, payload: { text: 'додай задачу' } })).json();
    expect(r.text).toBe('Підтвердьте.');
    expect(r.proposals).toHaveLength(1);
    expect(env.notion.titles('tasks')).toEqual([]);

    const pending = (await app.inject({ url: '/api/pending', headers: { cookie } })).json();
    expect(pending.items.map((p: { id: string }) => p.id)).toEqual([r.proposals[0].id]);

    const c = (await app.inject({ method: 'POST', url: `/api/pending/${r.proposals[0].id}/confirm`, headers: { ...H, cookie } })).json();
    expect(c.ok).toBe(true);
    expect(env.notion.titles('tasks')).toEqual(['Задача з вебу']);
    const again = (await app.inject({ method: 'POST', url: `/api/pending/${r.proposals[0].id}/confirm`, headers: { ...H, cookie } })).json();
    expect(again.ok).toBe(false);

    const history = (await app.inject({ url: '/api/history', headers: { cookie } })).json();
    expect(history.messages.map((m: { content: string }) => m.content)).toEqual(['додай задачу', 'Підтвердьте.', expect.stringContaining('Підтверджено')]);
  });

  it('voice: transcribes the upload and answers', async () => {
    const { app, cookie, env } = await setup();
    env.llm.transcripts.push('що в мене сьогодні');
    env.llm.script.push(say('Дві зустрічі.'));
    const res = await app.inject({ method: 'POST', url: '/api/voice', headers: { ...H, cookie, 'content-type': 'audio/webm' }, payload: Buffer.alloc(4000, 1) });
    expect(res.json()).toMatchObject({ transcript: 'що в мене сьогодні', text: 'Дві зустрічі.' });
  });

  it('import: text becomes a pending note, project can be picked, then saved', async () => {
    const { app, cookie, env } = await setup();
    env.llm.script.push(say(JSON.stringify({ project: null, title: 'Стратегія', source: 'ChatGPT' })));
    const { proposal } = (await app.inject({ method: 'POST', url: '/api/import', headers: { ...H, cookie }, payload: { text: 'Довга відповідь ChatGPT' } })).json();
    expect(proposal.project).toBeNull();
    expect((await app.inject({ method: 'POST', url: `/api/pending/${proposal.id}/project`, headers: { ...H, cookie }, payload: { project: 'Nope' } })).statusCode).toBe(400);
    const picked = (await app.inject({ method: 'POST', url: `/api/pending/${proposal.id}/project`, headers: { ...H, cookie }, payload: { project: 'Beta' } })).json();
    expect(picked.proposal.summary).toContain('→ Beta');
    await app.inject({ method: 'POST', url: `/api/pending/${proposal.id}/confirm`, headers: { ...H, cookie } });
    expect(env.notion.titles('notes')).toEqual(['Стратегія']);
  });
});

describe('web data screens', () => {
  it('today: events without mirrors, conflicts, focus and upcoming tasks, partial on calendar failure', async () => {
    const { app, cookie, env } = await setup();
    const notion = await env.s.notion();
    await notion.createTask({ title: 'Сьогоднішня', project: 'Alpha', due: '2026-10-23' });
    await notion.createTask({ title: 'Прострочена', project: 'Alpha', due: '2026-10-20' });
    await notion.createTask({ title: 'Наступного тижня', project: 'Beta', due: '2026-10-27' });
    const a = env.calendar.add('work', { title: 'A', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T11:00:00+03:00' });
    const b = env.calendar.add('personal', { title: 'B', start: '2026-10-23T10:30:00+03:00', end: '2026-10-23T11:30:00+03:00' });
    env.calendar.add('personal', { title: 'Зайнято', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T11:00:00+03:00', mirror: true });
    const t = (await app.inject({ url: '/api/today', headers: { cookie } })).json();
    expect(t.events.map((e: { title: string }) => e.title)).toEqual(['A', 'B']);
    expect(t.conflicts).toEqual([[a.id, b.id]]);
    expect(t.focus.map((x: { title: string }) => x.title)).toEqual(['Прострочена', 'Сьогоднішня']);
    expect(t.upcoming.map((x: { title: string }) => x.title)).toEqual(['Наступного тижня']);

    env.calendar.list = async () => { throw new Error('google down'); };
    const partial = (await app.inject({ url: '/api/today', headers: { cookie } })).json();
    expect(partial.errors.calendar).toContain('google down');
    expect(partial.focus).toHaveLength(2);
  });

  it('tasks: quick add refuses duplicates, complete goes through the pending path', async () => {
    const { app, cookie, env } = await setup();
    const add = (title: string) => app.inject({ method: 'POST', url: '/api/tasks', headers: { ...H, cookie }, payload: { title, project: 'Alpha', due: '2026-10-25' } });
    expect((await add('Новий договір')).json().ok).toBe(true);
    expect((await add('новий договір')).statusCode).toBe(409);
    const [task] = (await app.inject({ url: '/api/tasks', headers: { cookie } })).json().tasks;
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/complete`, headers: { ...H, cookie } })).json().ok).toBe(true);
    expect((await app.inject({ url: '/api/tasks', headers: { cookie } })).json().tasks).toHaveLength(0);
    expect((await env.s.pending.listPending())).toHaveLength(0);
  });

  it('finance: month totals exact to the cent', async () => {
    const { app, cookie, env } = await setup();
    const notion = await env.s.notion();
    for (const amount of [0.1, 0.2, 45]) await notion.addFinance({ date: '2026-10-10', amount, currency: 'USD', kind: 'expense', category: 'Таксі', scope: 'personal', note: '' });
    await notion.addFinance({ date: '2026-09-30', amount: 999, currency: 'USD', kind: 'expense', category: 'Таксі', scope: 'personal', note: '' });
    const r = (await app.inject({ url: '/api/finance', headers: { cookie } })).json();
    expect(r).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(r.totals[0]).toMatchObject({ currency: 'USD', expense: 45.3, count: 3 });
  });

  it('settings: validated patch, notion mapping never exposed', async () => {
    const { app, cookie } = await setup();
    const get = (await app.inject({ url: '/api/settings', headers: { cookie } })).json();
    expect(get.notion).toBeUndefined();
    const bad = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...H, cookie }, payload: { morningTime: '25:00' } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...H, cookie }, payload: { projects: ['hack'] } });
    expect(unknown.statusCode).toBe(400);
    const ok = (await app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...H, cookie }, payload: { morningTime: '07:15', eventsTopics: ['AI'] } })).json();
    expect(ok).toMatchObject({ morningTime: '07:15', eventsTopics: ['AI'], projects: ['Alpha', 'Beta'] });
  });

  it('status reports integration states', async () => {
    const { app, cookie, env } = await setup();
    await env.s.tokens.save('google:personal', { meta: { broken: true } });
    const st = (await app.inject({ url: '/api/status', headers: { cookie } })).json();
    expect(st.integrations).toMatchObject({ work: { state: 'on' }, personal: { state: 'broken' }, instagram: { state: 'off' }, voice: { state: 'off' } });
  });
});
