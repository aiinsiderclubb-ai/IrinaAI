import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { verifyState } from './lib/crypto.js';
import { errMsg } from './lib/log.js';
import type { Services } from './services.js';
import type { Slot } from './store/tokens.js';

/** Updates are acknowledged immediately and processed one by one (LLM calls outlive Telegram's webhook timeout). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  add(fn: () => Promise<void>, onError: (e: unknown) => void): void {
    this.tail = this.tail.then(fn).catch(onError);
  }
  idle(): Promise<unknown> {
    return this.tail;
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h2>${title}</h2><p>${body}</p>`;

export function buildServer(s: Services, bot: Bot, queue = new SerialQueue()): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.get('/health', async (_req, reply) => {
    try {
      await s.db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post('/telegram/webhook', async (req, reply) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== s.cfg.TELEGRAM_WEBHOOK_SECRET) return reply.code(401).send();
    const update = req.body as { update_id?: number };
    if (typeof update?.update_id !== 'number') return reply.code(400).send();
    // Telegram retries unacknowledged updates: dedupe by update_id
    if (!(await s.messages.markUpdate(update.update_id))) return reply.code(200).send();
    queue.add(
      () => bot.handleUpdate(update as never),
      (e) => s.log.error('update_failed', { error: errMsg(e).slice(0, 300) }),
    );
    return reply.code(200).send();
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/oauth/google/callback', async (req, reply) => {
    reply.type('text/html');
    const st = req.query.state ? verifyState(req.query.state, s.cfg.APP_SECRET) : null;
    if (!st || st.owner !== String(s.cfg.OWNER_TELEGRAM_ID) || !st.slot?.startsWith('google:')) return reply.code(400).send(page('Посилання недійсне', 'Запустіть /connect у боті ще раз.'));
    if (req.query.error || !req.query.code || !s.googleAuth) return reply.code(400).send(page('Не вдалося підключити', esc(req.query.error ?? 'немає коду')));
    try {
      await s.googleAuth.exchangeCode(st.slot as Slot, req.query.code);
      await s.notify(`✅ Підключено: <b>${st.slot.replace('google:', 'Google · ')}</b>`);
      return reply.send(page('Готово ✅', 'Акаунт підключено. Можна закрити вкладку й повернутися до Telegram.'));
    } catch (e) {
      s.log.error('oauth_failed', { slot: st.slot, error: errMsg(e).slice(0, 300) });
      return reply.code(500).send(page('Помилка', 'Не вдалося завершити підключення. Спробуйте /connect ще раз.'));
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/oauth/instagram/callback', async (req, reply) => {
    reply.type('text/html');
    const st = req.query.state ? verifyState(req.query.state, s.cfg.APP_SECRET) : null;
    if (!st || st.owner !== String(s.cfg.OWNER_TELEGRAM_ID) || st.slot !== 'instagram') return reply.code(400).send(page('Посилання недійсне', 'Запустіть /connect у боті ще раз.'));
    if (req.query.error || !req.query.code || !s.instagram) return reply.code(400).send(page('Не вдалося підключити', esc(req.query.error ?? 'немає коду')));
    try {
      await s.instagram.exchangeCode(req.query.code.replace(/#_$/, ''));
      await s.notify('✅ Підключено: <b>Instagram</b>');
      return reply.send(page('Готово ✅', 'Instagram підключено. Можна закрити вкладку.'));
    } catch (e) {
      s.log.error('oauth_failed', { slot: 'instagram', error: errMsg(e).slice(0, 300) });
      return reply.code(500).send(page('Помилка', 'Не вдалося завершити підключення. Спробуйте /connect ще раз.'));
    }
  });

  return app;
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
