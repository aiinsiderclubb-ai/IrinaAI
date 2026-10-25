import { z } from 'zod';

/** Empty env values (`FOO=`) are treated as unset. */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: opt(z.string().url()),
  DATABASE_URL: z.string().min(1),
  /** base64, 32 bytes: `openssl rand -base64 32` */
  ENCRYPTION_KEY: z.string().min(1),
  /** signs OAuth `state`: `openssl rand -hex 32` */
  APP_SECRET: z.string().min(16),
  DEFAULT_TIMEZONE: z.string().default('Europe/Kyiv'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  TELEGRAM_WEBHOOK_SECRET: opt(z.string().min(8)),
  OWNER_TELEGRAM_ID: z.coerce.number().int(),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),
  OPENAI_SEARCH_MODEL: z.string().default('gpt-4.1'),
  /** spoken conversation: a faster model and transcription, latency matters more than nuance */
  OPENAI_VOICE_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_VOICE_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),
  /** live voice dialog in the web cabinet (speech-to-speech) */
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
  OPENAI_REALTIME_VOICE: z.string().default('marin'),
  /** voice replies when ElevenLabs is not configured */
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  OPENAI_TTS_VOICE: z.string().default('marin'),

  ELEVENLABS_API_KEY: opt(z.string()),
  ELEVENLABS_VOICE_ID: opt(z.string()),
  ELEVENLABS_MODEL: z.string().default('eleven_multilingual_v2'),

  NOTION_TOKEN: opt(z.string()),
  NOTION_VERSION: z.string().default('2022-06-28'),

  GOOGLE_CLIENT_ID: opt(z.string()),
  GOOGLE_CLIENT_SECRET: opt(z.string()),

  META_APP_ID: opt(z.string()),
  META_APP_SECRET: opt(z.string()),

  /** optional second way into the web UI besides the one-time link from the bot (/web) */
  WEB_PASSWORD: opt(z.string().min(10)),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.TELEGRAM_MODE === 'webhook' && (!cfg.PUBLIC_URL || !cfg.TELEGRAM_WEBHOOK_SECRET)) {
    throw new Error('TELEGRAM_MODE=webhook requires PUBLIC_URL and TELEGRAM_WEBHOOK_SECRET');
  }
  return cfg;
}

/** Where the owner opens the web UI and OAuth returns to. */
export function baseUrl(cfg: Config): string {
  return (cfg.PUBLIC_URL ?? `http://localhost:${cfg.PORT}`).replace(/\/$/, '');
}
