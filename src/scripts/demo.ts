/**
 * Local demo of the web UI without any external service:
 * in-memory Postgres (PGlite), fake Notion and Google Calendar with sample data, no Telegram.
 * The model is a keyword stub unless OPENAI_API_KEY is set (then the real agent runs on the fake data).
 *
 *   npm run build && npm run demo      -> http://localhost:3000 (login link is printed)
 *   npm run demo  +  npm run dev:web   -> http://localhost:5173 with hot reload
 */
import { randomBytes } from 'node:crypto';
import { loadDotEnv } from '../lib/env.js';
import { DateTime } from 'luxon';
import { Agent } from '../agent/agent.js';
import type { Config } from '../config.js';
import { createPgliteDb, migrate } from '../db/index.js';
import { DemoLlm } from '../dev/demoLlm.js';
import { FakeCalendar } from '../dev/fakeCalendar.js';
import { FakeNotion, TEST_SCHEMA } from '../dev/fakeNotion.js';
import { OpenAi } from '../integrations/openai.js';
import { ElevenLabs, OpenAiTts } from '../integrations/tts.js';
import { log } from '../lib/log.js';
import { saveSnapshot } from '../modules/social.js';
import { NotionRepo } from '../notion/repo.js';
import { buildServer } from '../server.js';
import type { Services } from '../services.js';
import { MemoryStore } from '../store/memory.js';
import { IntegrationStore } from '../store/integrations.js';
import { MessageStore } from '../store/messages.js';
import { PendingStore } from '../store/pending.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../store/settings.js';
import { TokenStore } from '../store/tokens.js';
import { registerWeb } from '../web/api.js';
import { createLoginToken } from '../web/auth.js';
import { seedDemo } from '../dev/seed.js';
import { createBot } from '../telegram/bot.js';
import { startScheduler } from '../scheduler.js';

loadDotEnv();

const ZONE = 'Europe/Kyiv';
const PORT = Number(process.env.PORT ?? 3000);
const PROJECTS = ['Запуск продукту', 'Інвестори', 'Команда'];

// real Telegram bot in the demo once a token and the paired owner id are in .env (npm run pair)
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const tgOwner = Number(process.env.OWNER_TELEGRAM_ID ?? 0);
// production (Render) owns the bot via webhook: the demo takes it over only when asked (DEMO_TELEGRAM=1)
const telegram = Boolean(tgToken && tgOwner && process.env.DEMO_TELEGRAM === '1');

const cfg = {
  NODE_ENV: 'development', PORT, DATABASE_URL: 'pglite', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_SECRET: randomBytes(32).toString('hex'),
  DEFAULT_TIMEZONE: ZONE, TELEGRAM_BOT_TOKEN: tgToken ?? 'demo', TELEGRAM_MODE: 'polling', OWNER_TELEGRAM_ID: telegram ? tgOwner : 1, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'demo',
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'gpt-4.1', OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-transcribe', OPENAI_SEARCH_MODEL: 'gpt-4.1', OPENAI_VOICE_MODEL: process.env.OPENAI_VOICE_MODEL ?? 'gpt-4.1-mini', OPENAI_VOICE_TRANSCRIBE_MODEL: process.env.OPENAI_VOICE_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe', OPENAI_REALTIME_MODEL: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime', OPENAI_REALTIME_VOICE: process.env.OPENAI_REALTIME_VOICE ?? 'marin', OPENAI_TTS_MODEL: 'gpt-4o-mini-tts', OPENAI_TTS_VOICE: 'marin', ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY, ELEVENLABS_MODEL: process.env.ELEVENLABS_MODEL ?? 'eleven_v4', ELEVENLABS_MODEL_FAST: process.env.ELEVENLABS_MODEL_FAST ?? 'eleven_v4_turbo',
  NOTION_TOKEN: 'demo', NOTION_VERSION: '2022-06-28', WEB_PASSWORD: process.env.WEB_PASSWORD ?? 'demo-password',
} as Config;

const db = await createPgliteDb();
await migrate(db);
const { settings, tokens, repo, calendar } = await seedDemo(db, cfg.ENCRYPTION_KEY, ZONE);

// ---------- services & server ----------
const s: Services = {
  cfg, db, clock: () => new Date(), log, settings, tokens,
  pending: new PendingStore(db), messages: new MessageStore(db), memory: new MemoryStore(db), integrations: new IntegrationStore(db, cfg.ENCRYPTION_KEY),
  llm: process.env.OPENAI_API_KEY ? new OpenAi(process.env.OPENAI_API_KEY, { chat: cfg.OPENAI_MODEL, transcribe: cfg.OPENAI_TRANSCRIBE_MODEL, search: cfg.OPENAI_SEARCH_MODEL }, (process.env.OPENAI_REASONING_EFFORT as 'low') ?? 'low') : new DemoLlm(ZONE),
  notion: async () => repo,
  calendar,
  tts: cfg.ELEVENLABS_API_KEY
    ? new ElevenLabs(cfg.ELEVENLABS_API_KEY, { fast: cfg.ELEVENLABS_MODEL_FAST, quality: cfg.ELEVENLABS_MODEL }, async () => { const st = await settings.get(); return { voice: st.elevenVoice, style: st.ttsStyle }; })
    : process.env.OPENAI_API_KEY ? new OpenAiTts(process.env.OPENAI_API_KEY, 'gpt-4o-mini-tts', async () => { const st = await settings.get(); return { voice: st.ttsVoice, style: st.ttsStyle }; }) : undefined,
  notify: async (html) => console.log(`\n[notify → Telegram]\n${html.replace(/<[^>]+>/g, '')}\n`),
};
const agent = new Agent(s);
let bot: ReturnType<typeof createBot> | undefined;
if (telegram) {
  bot = createBot(s, agent); // also replaces s.notify: reports and nudges go to Telegram
  await bot.init();
  await bot.api.deleteWebhook();
  void bot.start({ allowed_updates: ['message', 'callback_query'], onStart: () => console.log(`  Telegram: @${bot!.botInfo.username} is listening (owner ${tgOwner})`) });
  startScheduler(s);
}
const app = buildServer(s, (bot ?? { handleUpdate: async () => {} }) as never);
await registerWeb(app, s, agent);
await app.listen({ port: PORT, host: '127.0.0.1' });

const token = await createLoginToken(db, 24 * 60);
console.log(`
  Demo is running (in-memory data, nothing leaves this machine${process.env.OPENAI_API_KEY ? ' except OpenAI calls' : ''}).
  Model: ${process.env.OPENAI_API_KEY ? `OpenAI ${cfg.OPENAI_MODEL}` : 'keyword stub (set OPENAI_API_KEY for the real agent)'}
  Voice: ${cfg.ELEVENLABS_API_KEY ? `ElevenLabs (${cfg.ELEVENLABS_MODEL_FAST} live / ${cfg.ELEVENLABS_MODEL} quality)` : process.env.OPENAI_API_KEY ? 'OpenAI gpt-4o-mini-tts' : 'off'}

  Open:      http://localhost:${PORT}/#/login?token=${token}
  Password:  ${cfg.WEB_PASSWORD}
  (with Vite dev server use port 5173 instead of ${PORT})
  Telegram:  ${telegram ? 'on (polling)' : tgToken ? (tgOwner ? 'off (DEMO_TELEGRAM=1 to take the bot over from Render)' : 'token set, run `npm run pair` to link your account') : 'off (no TELEGRAM_BOT_TOKEN)'}
`);
