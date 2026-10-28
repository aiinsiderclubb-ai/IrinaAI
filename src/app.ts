import { baseUrl, type Config } from './config.js';
import type { Db } from './db/index.js';
import { GoogleAuth } from './integrations/google-auth.js';
import { GoogleCalendar } from './integrations/google-calendar.js';
import { InstagramClient } from './integrations/instagram.js';
import { OpenAi } from './integrations/openai.js';
import { ElevenLabs, OpenAiTts } from './integrations/tts.js';
import { YouTubeClient } from './integrations/youtube.js';
import { log } from './lib/log.js';
import { systemClock } from './lib/time.js';
import { NotionHttp } from './notion/client.js';
import { NotionNotConfigured, NotionRepo } from './notion/repo.js';
import { NotConnected, type Services } from './services.js';
import { MemoryStore } from './store/memory.js';
import { MessageStore } from './store/messages.js';
import { PendingStore } from './store/pending.js';
import { DEFAULT_SETTINGS, SettingsStore } from './store/settings.js';
import { TokenStore } from './store/tokens.js';

/** Wires real integrations from env. Integrations without credentials are simply left out. */
export function createServices(cfg: Config, db: Db): Services {
  const clock = systemClock;
  const settings = new SettingsStore(db, DEFAULT_SETTINGS(cfg.DEFAULT_TIMEZONE));
  const tokens = new TokenStore(db, cfg.ENCRYPTION_KEY);
  const base = baseUrl(cfg);

  const googleAuth =
    cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && base
      ? new GoogleAuth({ clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, redirectUri: `${base}/oauth/google/callback` }, tokens, clock)
      : undefined;
  const instagram =
    cfg.META_APP_ID && cfg.META_APP_SECRET && base
      ? new InstagramClient({ appId: cfg.META_APP_ID, appSecret: cfg.META_APP_SECRET, redirectUri: `${base}/oauth/instagram/callback` }, tokens, clock)
      : undefined;

  const notionApi = cfg.NOTION_TOKEN ? new NotionHttp(cfg.NOTION_TOKEN, cfg.NOTION_VERSION) : undefined;
  let cached: { schema: unknown; repo: NotionRepo } | undefined;

  return {
    cfg,
    db,
    clock,
    log,
    settings,
    tokens,
    pending: new PendingStore(db),
    messages: new MessageStore(db),
    memory: new MemoryStore(db),
    llm: new OpenAi(cfg.OPENAI_API_KEY, { chat: cfg.OPENAI_MODEL, transcribe: cfg.OPENAI_TRANSCRIBE_MODEL, search: cfg.OPENAI_SEARCH_MODEL }, cfg.OPENAI_REASONING_EFFORT),
    async notion() {
      if (!notionApi) throw new NotConnected('Notion не підключено (NOTION_TOKEN)');
      const st = await settings.get();
      if (!st.notion) throw new NotionNotConfigured('схему баз (setup:notion)');
      if (cached?.schema !== st.notion) cached = { schema: st.notion, repo: new NotionRepo(notionApi, st.notion) };
      return cached.repo;
    },
    notionApi,
    googleAuth,
    calendar: googleAuth ? new GoogleCalendar(googleAuth) : undefined,
    youtube: googleAuth ? new YouTubeClient(googleAuth, clock) : undefined,
    instagram,
    // ElevenLabs when a key is set (most human), otherwise OpenAI speech on the same key
    tts: cfg.ELEVENLABS_API_KEY
      ? new ElevenLabs(cfg.ELEVENLABS_API_KEY, { fast: cfg.ELEVENLABS_MODEL_FAST, quality: cfg.ELEVENLABS_MODEL }, async () => {
          const st = await settings.get();
          return { voice: cfg.ELEVENLABS_VOICE_ID && !st.elevenVoice ? cfg.ELEVENLABS_VOICE_ID : st.elevenVoice, style: st.ttsStyle };
        })
      : new OpenAiTts(cfg.OPENAI_API_KEY, cfg.OPENAI_TTS_MODEL, async () => {
          const st = await settings.get();
          return { voice: st.ttsVoice || cfg.OPENAI_TTS_VOICE, style: st.ttsStyle };
        }),
    notify: async () => {
      throw new Error('notify is not wired yet');
    },
  };
}
