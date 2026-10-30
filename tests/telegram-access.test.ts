import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { buildServer } from '../src/server.js';
import { IntegrationStore } from '../src/store/integrations.js';
import { createBot } from '../src/telegram/bot.js';
import { registerWeb } from '../src/web/api.js';
import { issueSession, SESSION_COOKIE } from '../src/web/auth.js';
import { makeEnv, say } from './helpers/services.js';

const OWNER = 42;
const FRIEND = 777;

async function setup() {
  const env = await makeEnv();
  env.s.integrations = new IntegrationStore(env.db, env.s.cfg.ENCRYPTION_KEY);
  const agent = new Agent(env.s);
  const bot = createBot(env.s, agent);
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as never;
  const sent: Array<{ chat: number; text: string }> = [];
  bot.api.config.use(async (_prev, method, payload: any) => {
    if (method === 'sendMessage') sent.push({ chat: payload.chat_id, text: payload.text });
    return { ok: true, result: method === 'sendMessage' ? { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' } } : true } as never;
  });
  const app = buildServer(env.s, {} as never);
  await registerWeb(app, env.s, agent, { serveStatic: false });
  const H = { 'x-requested-with': 'aia', cookie: `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, OWNER, env.s.clock().getTime())}` };
  let n = 0;
  const write = (from: number, text: string) =>
    bot.handleUpdate({
      update_id: ++n,
      message: { message_id: n, date: 0, text, chat: { id: from, type: 'private', first_name: 'Влад' }, from: { id: from, is_bot: false, first_name: 'Влад', username: 'vlad' } },
    } as never);
  return { env, app, H, sent, write };
}

describe('Telegram access list', () => {
  it('a stranger gets no data, only their ID once, and shows up as a request in the cabinet', async () => {
    const { env, app, H, sent, write } = await setup();
    await write(FRIEND, 'покажи мої задачі');
    await write(FRIEND, 'ще раз');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat: FRIEND });
    expect(sent[0]!.text).toContain(`Ваш Telegram ID: ${FRIEND}`);
    expect(env.llm.calls).toHaveLength(0);
    const v = (await app.inject({ method: 'GET', url: '/api/integrations/telegram', headers: H })).json();
    expect(v).toMatchObject({ ownerId: OWNER, allowed: [], requests: [{ id: FRIEND, name: 'Влад', username: 'vlad' }] });
  });

  it('once allowed in the cabinet the person can talk to the assistant; reports reach them only when switched on', async () => {
    const { env, app, H, sent, write } = await setup();
    await write(FRIEND, 'привіт');
    const allowed = await app.inject({ method: 'POST', url: '/api/integrations/telegram', headers: H, payload: { id: FRIEND } });
    expect(allowed.json()).toMatchObject({ allowed: [{ id: FRIEND, name: 'Влад', reports: false }], requests: [] });

    env.llm.script.push(say('Привіт, Владе!'));
    sent.length = 0;
    await write(FRIEND, 'привіт');
    expect(sent).toEqual([{ chat: FRIEND, text: 'Привіт, Владе!' }]);

    sent.length = 0;
    await env.s.notify('звіт');
    expect(sent.map((m) => m.chat)).toEqual([OWNER]);
    await app.inject({ method: 'PATCH', url: `/api/integrations/telegram/${FRIEND}`, headers: H, payload: { reports: true } });
    sent.length = 0;
    await env.s.notify('звіт');
    expect(sent.map((m) => m.chat)).toEqual([OWNER, FRIEND]);

    await app.inject({ method: 'DELETE', url: `/api/integrations/telegram/${FRIEND}`, headers: H });
    sent.length = 0;
    await write(FRIEND, 'привіт');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('приватний');
  });

  it('rejects bad ids and the owner id', async () => {
    const { app, H } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/integrations/telegram', headers: H, payload: { id: 'abc' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/telegram', headers: H, payload: { id: OWNER } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/integrations/telegram' })).statusCode).toBe(401);
  });
});
