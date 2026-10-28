import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { OpenAi } from './integrations/openai.js';
import { applyIntegrations } from './integrations/runtime.js';
import { log } from './lib/log.js';
import { systemClock } from './lib/time.js';
import type { Services } from './services.js';
import { IntegrationStore } from './store/integrations.js';
import { MemoryStore } from './store/memory.js';
import { MessageStore } from './store/messages.js';
import { PendingStore } from './store/pending.js';
import { DEFAULT_SETTINGS, SettingsStore } from './store/settings.js';
import { TokenStore } from './store/tokens.js';

/** Stores and the model; integrations are applied by applyIntegrations (cabinet settings, env as fallback). */
export async function createServices(cfg: Config, db: Db): Promise<Services> {
  const clock = systemClock;
  const settings = new SettingsStore(db, DEFAULT_SETTINGS(cfg.DEFAULT_TIMEZONE));
  const s: Services = {
    cfg,
    db,
    clock,
    log,
    settings,
    tokens: new TokenStore(db, cfg.ENCRYPTION_KEY),
    pending: new PendingStore(db),
    messages: new MessageStore(db),
    memory: new MemoryStore(db),
    integrations: new IntegrationStore(db, cfg.ENCRYPTION_KEY),
    llm: new OpenAi(cfg.OPENAI_API_KEY, { chat: cfg.OPENAI_MODEL, transcribe: cfg.OPENAI_TRANSCRIBE_MODEL, search: cfg.OPENAI_SEARCH_MODEL }, cfg.OPENAI_REASONING_EFFORT),
    notion: async () => {
      throw new Error('integrations not applied');
    },
    notify: async () => {
      throw new Error('notify is not wired yet');
    },
  };
  await applyIntegrations(s);
  return s;
}
