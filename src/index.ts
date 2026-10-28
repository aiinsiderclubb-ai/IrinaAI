import { Agent } from './agent/agent.js';
import { loadDotEnv } from './lib/env.js';
import { createServices } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb, migrate } from './db/index.js';
import { log } from './lib/log.js';
import { startScheduler } from './scheduler.js';
import { buildServer } from './server.js';
import { createBot } from './telegram/bot.js';
import { registerWeb } from './web/api.js';

loadDotEnv();

const cfg = loadConfig();
const db = createPgDb(cfg.DATABASE_URL);
const applied = await migrate(db);
if (applied.length) log.info('migrations_applied', { applied });

const services = createServices(cfg, db);
const agent = new Agent(services);
const bot = createBot(services, agent);
await bot.init();

const server = buildServer(services, bot);
await registerWeb(server, services, agent);
await server.listen({ port: cfg.PORT, host: '0.0.0.0' });
log.info('listening', { port: cfg.PORT, mode: cfg.TELEGRAM_MODE });

if (cfg.TELEGRAM_MODE === 'webhook') {
  await bot.api.setWebhook(`${cfg.PUBLIC_URL!.replace(/\/$/, '')}/telegram/webhook`, {
    secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });
} else {
  await bot.api.deleteWebhook();
  void bot.start({ allowed_updates: ['message', 'callback_query'] });
}

const stopScheduler = startScheduler(services);

// keep a free Render instance awake: inbound traffic through the public URL counts, localhost does not
let keepalive: NodeJS.Timeout | undefined;
if (cfg.KEEPALIVE_MINUTES > 0 && cfg.PUBLIC_URL) {
  const url = `${cfg.PUBLIC_URL.replace(/\/$/, '')}/health`;
  keepalive = setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => log.warn('keepalive_failed', { error: String(e).slice(0, 120) }));
  }, cfg.KEEPALIVE_MINUTES * 60_000);
  log.info('keepalive_on', { minutes: cfg.KEEPALIVE_MINUTES });
}

async function shutdown(signal: string) {
  log.info('shutdown', { signal });
  stopScheduler();
  clearInterval(keepalive);
  await bot.stop().catch(() => {});
  await server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
