/**
 * One-time pairing: learns the owner's Telegram id so the bot answers only them.
 *   npm run pair   -> send /start to the bot from your account; OWNER_TELEGRAM_ID is written to .env
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../lib/env.js';

loadDotEnv();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set (.env)');
  process.exit(1);
}
const api = async <T>(method: string, body: Record<string, unknown> = {}): Promise<T> => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
};

const me = await api<{ username: string }>('getMe');
await api('deleteWebhook', { drop_pending_updates: false });
console.log(`\n  Open https://t.me/${me.username} from YOUR Telegram account and send /start (waiting up to 10 minutes)…\n`);

const deadline = Date.now() + 10 * 60_000;
let offset = 0;
while (Date.now() < deadline) {
  const updates = await api<Array<{ update_id: number; message?: { chat: { id: number; type: string }; from?: { id: number; first_name?: string; username?: string }; text?: string } }>>('getUpdates', {
    offset,
    timeout: 30,
    allowed_updates: ['message'],
  });
  for (const u of updates) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m?.from || m.chat.type !== 'private' || !m.text?.startsWith('/start')) continue;
    const id = m.from.id;
    const env = readFileSync('.env', 'utf8');
    const next = /^OWNER_TELEGRAM_ID=.*$/m.test(env) ? env.replace(/^OWNER_TELEGRAM_ID=.*$/m, `OWNER_TELEGRAM_ID=${id}`) : `${env.trimEnd()}\nOWNER_TELEGRAM_ID=${id}\n`;
    writeFileSync('.env', next);
    await api('getUpdates', { offset, timeout: 0 }); // acknowledge, so the bot does not see /start twice
    await api('sendMessage', { chat_id: id, text: `✅ Підключено. Тепер я відповідаю тільки тобі, ${m.from.first_name ?? ''}. Пиши або надсилай голосові.` });
    console.log(`  Paired with ${m.from.first_name ?? ''} ${m.from.username ? `(@${m.from.username})` : ''}: OWNER_TELEGRAM_ID=${id} saved to .env\n`);
    process.exit(0);
  }
}
console.error('  Timed out: nobody sent /start. Run `npm run pair` again.');
process.exit(1);
