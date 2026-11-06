import { baseUrl } from '../config.js';
import { NotionHttp } from '../notion/client.js';
import { NotionNotConfigured, NotionRepo } from '../notion/repo.js';
import { NotConnected, type Services } from '../services.js';
import { GoogleAuth } from './google-auth.js';
import { GoogleCalendar } from './google-calendar.js';
import { InstagramClient } from './instagram.js';
import { OpenAi } from './openai.js';
import { ElevenLabs, OpenAiTts } from './tts.js';
import { YouTubeClient } from './youtube.js';
import type { NotionAccess } from '../store/integrations.js';

/**
 * (Re)builds every integration from the cabinet settings, with env vars as fallback.
 * Called at start and after each change in Опції → Підключення, so nothing needs a redeploy.
 */
/** the key the assistant actually uses: the client's from the cabinet, else the server's */
export async function activeOpenAiKey(s: Services): Promise<{ key: string; source: 'cabinet' | 'server' }> {
  const k = (await s.integrations?.get())?.openai?.apiKey;
  return k ? { key: k, source: 'cabinet' } : { key: s.cfg.OPENAI_API_KEY, source: 'server' };
}

export async function applyIntegrations(s: Services): Promise<void> {
  const cfg = s.cfg;
  const ic = (await s.integrations?.get()) ?? {};
  const base = baseUrl(cfg);

  const openaiKey = ic.openai?.apiKey || cfg.OPENAI_API_KEY;
  if (s.llm instanceof OpenAi || !s.llm) s.llm = new OpenAi(openaiKey, { chat: cfg.OPENAI_MODEL, transcribe: cfg.OPENAI_TRANSCRIBE_MODEL, search: cfg.OPENAI_SEARCH_MODEL }, cfg.OPENAI_REASONING_EFFORT);

  const g = { id: ic.google?.clientId || cfg.GOOGLE_CLIENT_ID, secret: ic.google?.clientSecret || cfg.GOOGLE_CLIENT_SECRET };
  s.googleAuth = g.id && g.secret ? new GoogleAuth({ clientId: g.id, clientSecret: g.secret, redirectUri: `${base}/oauth/google/callback` }, s.tokens, s.clock) : undefined;
  const calendars = ic.google?.calendars ?? {};
  s.calendar = s.googleAuth ? new GoogleCalendar(s.googleAuth, (a) => calendars[a] || 'primary') : undefined;
  s.youtube = s.googleAuth ? new YouTubeClient(s.googleAuth, s.clock, () => ic.google?.youtubeChannel) : undefined;

  const m = { id: ic.meta?.appId || cfg.META_APP_ID, secret: ic.meta?.appSecret || cfg.META_APP_SECRET };
  s.instagram = m.id && m.secret ? new InstagramClient({ appId: m.id, appSecret: m.secret, redirectUri: `${base}/oauth/instagram/callback`, login: ic.meta?.login, configId: ic.meta?.configId }, s.tokens, s.clock) : undefined;

  const eleven = ic.elevenlabs?.apiKey || cfg.ELEVENLABS_API_KEY;
  s.tts = eleven
    ? new ElevenLabs(eleven, { fast: cfg.ELEVENLABS_MODEL_FAST, quality: cfg.ELEVENLABS_MODEL }, async () => {
        const st = await s.settings.get();
        return { voice: cfg.ELEVENLABS_VOICE_ID && !st.elevenVoice ? cfg.ELEVENLABS_VOICE_ID : st.elevenVoice, style: st.ttsStyle };
      })
    : new OpenAiTts(openaiKey, cfg.OPENAI_TTS_MODEL, async () => {
        const st = await s.settings.get();
        return { voice: st.ttsVoice || cfg.OPENAI_TTS_VOICE, style: st.ttsStyle };
      });

  const notionToken = ic.notion?.token || cfg.NOTION_TOKEN;
  s.notionApi = notionToken ? new NotionHttp(notionToken, cfg.NOTION_VERSION) : undefined;
  let cached: { schema: unknown; repo: NotionRepo } | undefined;
  const api = s.notionApi;
  s.notion = async () => {
    if (!api) throw new NotConnected('Notion не підключено (Опції → Підключення)');
    const st = await s.settings.get();
    if (!st.notion) throw new NotionNotConfigured('базу задач (Опції → Підключення → Notion)');
    if (cached?.schema !== st.notion) cached = { schema: st.notion, repo: new NotionRepo(api, st.notion) };
    return cached.repo;
  };
}

/** Same rule as Notion: once Google is set up from the cabinet, the calendar is read-only until the owner allows writes. */
export async function calendarWritable(s: Services): Promise<boolean> {
  const ic = (await s.integrations?.get()) ?? {};
  return ic.google ? ic.google.readOnly === false : true;
}

export async function notionAccess(s: Services): Promise<NotionAccess> {
  const ic = (await s.integrations?.get()) ?? {};
  if (!ic.notion) return 'full';
  return ic.notion.access ?? (ic.notion.readOnly === false ? 'full' : 'read');
}

/** In `create` mode only new tasks may be written: nothing that already exists is changed. */
export async function notionAllows(s: Services, kind: string): Promise<boolean> {
  const access = await notionAccess(s);
  return access === 'full' || (access === 'create' && kind === 'task.create');
}
