import { describe, expect, it, vi } from 'vitest';
import { signState } from '../src/lib/crypto.js';
import { classifyImport } from '../src/modules/importer.js';
import { buildServer, SerialQueue } from '../src/server.js';
import { chunk } from '../src/telegram/bot.js';
import { makeEnv, say } from './helpers/services.js';

const secret = { 'x-telegram-bot-api-secret-token': 'whsecret123' };

describe('webhook', () => {
  it('rejects a wrong secret, acks fast, dedupes retries, processes updates in order', async () => {
    const env = await makeEnv();
    const order: number[] = [];
    const bot = {
      handleUpdate: async (u: { update_id: number }) => {
        await new Promise((r) => setTimeout(r, u.update_id === 1 ? 40 : 1));
        order.push(u.update_id);
      },
    };
    const queue = new SerialQueue();
    const app = buildServer(env.s, bot as never, queue);

    expect((await app.inject({ method: 'POST', url: '/telegram/webhook', payload: { update_id: 1 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'bad' }, payload: { update_id: 1 } })).statusCode).toBe(401);

    for (const id of [1, 2, 1]) expect((await app.inject({ method: 'POST', url: '/telegram/webhook', headers: secret, payload: { update_id: id } })).statusCode).toBe(200);
    await queue.idle();
    expect(order).toEqual([1, 2]); // retried update 1 ignored, order kept despite slower first handler
    await app.close();
  });

  it('a failing handler does not stop the queue', async () => {
    const env = await makeEnv();
    const seen: number[] = [];
    const bot = { handleUpdate: async (u: { update_id: number }) => { if (u.update_id === 10) throw new Error('boom'); seen.push(u.update_id); } };
    const queue = new SerialQueue();
    const app = buildServer(env.s, bot as never, queue);
    for (const id of [10, 11]) await app.inject({ method: 'POST', url: '/telegram/webhook', headers: secret, payload: { update_id: id } });
    await queue.idle();
    expect(seen).toEqual([11]);
  });

  it('health checks the database', async () => {
    const env = await makeEnv();
    const app = buildServer(env.s, {} as never);
    expect((await app.inject('/health')).json()).toEqual({ ok: true });
  });
});

describe('oauth callbacks', () => {
  it('accept only a valid signed state for the owner, then store and notify', async () => {
    const env = await makeEnv();
    const exchangeCode = vi.fn(async () => {});
    env.s.googleAuth = { exchangeCode } as never;
    const app = buildServer(env.s, {} as never);
    const good = signState({ slot: 'google:work', owner: '42' }, env.s.cfg.APP_SECRET);

    expect((await app.inject(`/oauth/google/callback?code=abc&state=${good}`)).statusCode).toBe(200);
    expect(exchangeCode).toHaveBeenCalledWith('google:work', 'abc');
    expect(env.notified.join()).toContain('Google · work');

    const stranger = signState({ slot: 'google:work', owner: '999' }, env.s.cfg.APP_SECRET);
    expect((await app.inject(`/oauth/google/callback?code=abc&state=${stranger}`)).statusCode).toBe(400);
    expect((await app.inject('/oauth/google/callback?code=abc&state=forged.sig')).statusCode).toBe(400);
    expect((await app.inject('/oauth/google/callback?code=abc')).statusCode).toBe(400);
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });
});

describe('importer', () => {
  it('maps a forwarded answer to a known project only', async () => {
    const env = await makeEnv();
    env.llm.chat = async () => say(JSON.stringify({ project: 'beta', title: 'План запуску', source: 'ChatGPT' }));
    expect(await classifyImport(env.llm, ['Alpha', 'Beta'], 'текст', undefined)).toEqual({ project: 'Beta', title: 'План запуску', source: 'ChatGPT' });
    env.llm.chat = async () => say(JSON.stringify({ project: 'Invented', title: 'X', source: 'Dot' }));
    expect((await classifyImport(env.llm, ['Alpha', 'Beta'], 'текст')).project).toBeUndefined();
    env.llm.chat = async () => { throw new Error('down'); };
    const fallback = await classifyImport(env.llm, ['Alpha'], 'Перший рядок\nдругий');
    expect(fallback.title).toBe('Перший рядок');
    expect(fallback.project).toBeUndefined();
  });
});

describe('telegram chunking', () => {
  it('splits on paragraph boundaries under the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `<b>S${i}</b>\n${'x'.repeat(300)}`).join('\n\n');
    const parts = chunk(text, 4000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
    expect(parts.join('\n\n')).toBe(text);
    expect(chunk('short')).toEqual(['short']);
    expect(chunk('y'.repeat(9000), 4000).every((p) => p.length <= 4000)).toBe(true);
  });
});
