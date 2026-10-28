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

/**
 * (Re)builds every integration from the cabinet settings, with env vars as fallback.
 * Called at start and after each change in Опції → Підключення, so nothing needs a redeploy.
 */
export async function applyIntegrations(s: Services): Promise<void> {
  const cfg = s.cfg;
  const ic = (await s.integrations?.get()) ?? {};
  const base = baseUrl(cfg);

  const openaiKey = ic.openai?.apiKey || cfg.OPENAI_API_KEY;
  if (s.llm instanceof OpenAi || !s.llm) s.llm = new OpenAi(openaiKey, { chat: cfg.OPENAI_MODEL, transcribe: cfg.OPENAI_TRANSCRIBE_MODEL, search: cfg.OPENAI_SEARCH_MODEL }, cfg.OPENAI_REASONING_EFFORT);

  const g = { id: ic.google?.clientId || cfg.GOOGLE_CLIENT_ID, secret: ic.google?.clientSecret || cfg.GOOGLE_CLIENT_SECRET };
  s.googleAuth = g.id && g.secret ? new GoogleAuth({ clientId: g.id, clientSecret: g.secret, redirectUri: `${base}/oauth/google/callback` }, s.tokens, s.clock) : undefined;
  s.calendar = s.googleAuth ? new GoogleCalendar(s.googleAuth) : undefined;
  s.youtube = s.googleAuth ? new YouTubeClient(s.googleAuth, s.clock) : undefined;

  const m = { id: ic.meta?.appId || cfg.META_APP_ID, secret: ic.meta?.appSecret || cfg.META_APP_SECRET };
  s.instagram = m.id && m.secret ? new InstagramClient({ appId: m.id, appSecret: m.secret, redirectUri: `${base}/oauth/instagram/callback` }, s.tokens, s.clock) : undefined;

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

/** Notion writes are allowed only when the owner switched read-only off. */
export async function notionWritable(s: Services): Promise<boolean> {
  const ic = (await s.integrations?.get()) ?? {};
  return ic.notion ? ic.notion.readOnly === false : true;
}
