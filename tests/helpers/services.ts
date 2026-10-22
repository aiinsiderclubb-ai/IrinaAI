import { randomBytes } from 'node:crypto';
import { createPgliteDb, migrate, type Db } from '../../src/db/index.js';
import type { Config } from '../../src/config.js';
import type { ChatResult, Llm, LlmMessage, ToolSpec } from '../../src/integrations/openai.js';
import { silentLog } from '../../src/lib/log.js';
import { NotionRepo } from '../../src/notion/repo.js';
import type { Services } from '../../src/services.js';
import { MemoryStore } from '../../src/store/memory.js';
import { MessageStore } from '../../src/store/messages.js';
import { PendingStore } from '../../src/store/pending.js';
import { DEFAULT_SETTINGS, SettingsStore, type Settings } from '../../src/store/settings.js';
import { TokenStore } from '../../src/store/tokens.js';
import { FakeCalendar } from '../../src/dev/fakeCalendar.js';
import { FakeNotion, TEST_SCHEMA } from '../../src/dev/fakeNotion.js';

/** Scripted model: each element answers one `chat` call. */
export class ScriptedLlm implements Llm {
  calls: Array<{ messages: LlmMessage[]; tools?: ToolSpec[] }> = [];
  transcripts: string[] = [];
  searchAnswer = '[]';
  constructor(public script: Array<ChatResult | ((messages: LlmMessage[]) => ChatResult)> = []) {}

  async chat(args: { messages: LlmMessage[]; tools?: ToolSpec[] }): Promise<ChatResult> {
    this.calls.push({ messages: args.messages, tools: args.tools });
    const next = this.script.shift();
    if (!next) return { content: 'ok', toolCalls: [] };
    return typeof next === 'function' ? next(args.messages) : next;
  }
  async transcribe(): Promise<string> {
    return this.transcripts.shift() ?? '';
  }
  async webSearch(): Promise<string> {
    return this.searchAnswer;
  }
}

export const toolCall = (name: string, args: unknown, id = `call-${name}`) => ({ content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
export const say = (content: string): ChatResult => ({ content, toolCalls: [] });

export const testConfig = (): Config =>
  ({
    NODE_ENV: 'test',
    PORT: 0,
    DATABASE_URL: 'x',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    APP_SECRET: 'test-secret-test-secret',
    DEFAULT_TIMEZONE: 'Europe/Kyiv',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_MODE: 'polling',
    TELEGRAM_WEBHOOK_SECRET: 'whsecret123',
    OWNER_TELEGRAM_ID: 42,
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'm',
    OPENAI_TRANSCRIBE_MODEL: 'm',
    OPENAI_SEARCH_MODEL: 'm',
    OPENAI_REALTIME_MODEL: 'gpt-realtime',
    OPENAI_REALTIME_VOICE: 'marin',
    OPENAI_TTS_MODEL: 'gpt-4o-mini-tts',
    OPENAI_TTS_VOICE: 'marin',
    ELEVENLABS_MODEL: 'm',
    NOTION_VERSION: '2022-06-28',
  }) as Config;

export interface TestEnv {
  s: Services;
  db: Db;
  notion: FakeNotion;
  calendar: FakeCalendar;
  llm: ScriptedLlm;
  notified: string[];
  setNow(iso: string): void;
}

export async function makeEnv(opts: { now?: string; settings?: Partial<Settings>; connectCalendars?: boolean; db?: Db } = {}): Promise<TestEnv> {
  const db = opts.db ?? (await createPgliteDb());
  await migrate(db);
  let nowMs = new Date(opts.now ?? '2026-10-23T05:00:00Z').getTime(); // 08:00 Kyiv (UTC+3)
  const clock = () => new Date(nowMs);
  const cfg = testConfig();
  const settings = new SettingsStore(db, DEFAULT_SETTINGS('Europe/Kyiv'));
  await settings.update({
    notion: TEST_SCHEMA,
    projects: ['Alpha', 'Beta'],
    categories: { expense: ['Таксі', 'Їжа'], income: ['Клієнт'] },
    ...opts.settings,
  });
  const tokens = new TokenStore(db, cfg.ENCRYPTION_KEY);
  if (opts.connectCalendars !== false) {
    await tokens.save('google:work', { refreshToken: 'r1', meta: {} });
    await tokens.save('google:personal', { refreshToken: 'r2', meta: {} });
  }
  const notion = new FakeNotion(clock);
  const repo = new NotionRepo(notion, TEST_SCHEMA, () => nowMs);
  const calendar = new FakeCalendar();
  const llm = new ScriptedLlm();
  const notified: string[] = [];
  const s: Services = {
    cfg,
    db,
    clock,
    log: silentLog,
    settings,
    tokens,
    pending: new PendingStore(db),
    messages: new MessageStore(db),
    memory: new MemoryStore(db),
    llm,
    notion: async () => repo,
    calendar,
    notify: async (html) => void notified.push(html),
  };
  return { s, db, notion, calendar, llm, notified, setNow: (iso) => void (nowMs = new Date(iso).getTime()) };
}
