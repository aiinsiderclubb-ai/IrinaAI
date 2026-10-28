import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { GoogleAuth } from './integrations/google-auth.js';
import type { Account, CalEvent, CalendarPort } from './integrations/google-calendar.js';
import { ACCOUNTS } from './integrations/google-calendar.js';
import type { InstagramClient } from './integrations/instagram.js';
import type { Llm } from './integrations/openai.js';
import type { Tts } from './integrations/tts.js';
import type { YouTubeClient } from './integrations/youtube.js';
import type { Logger } from './lib/log.js';
import type { Clock } from './lib/time.js';
import type { NotionApi } from './notion/client.js';
import type { NotionRepo } from './notion/repo.js';
import type { MemoryStore } from './store/memory.js';
import type { MessageStore } from './store/messages.js';
import type { PendingStore } from './store/pending.js';
import type { SettingsStore } from './store/settings.js';
import type { TokenStore } from './store/tokens.js';

/** Raised when an integration needed for the request is not set up: the assistant relays it to the owner. */
export class NotConnected extends Error {}

export interface Services {
  cfg: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  settings: SettingsStore;
  tokens: TokenStore;
  pending: PendingStore;
  messages: MessageStore;
  memory: MemoryStore;
  llm: Llm;
  notion(): Promise<NotionRepo>;
  /** raw Notion API (read-only uses such as the owner context), present when NOTION_TOKEN is set */
  notionApi?: NotionApi;
  calendar?: CalendarPort;
  googleAuth?: GoogleAuth;
  instagram?: InstagramClient;
  youtube?: YouTubeClient;
  tts?: Tts;
  /** sends an HTML message to the owner (set once the bot exists) */
  notify: (html: string) => Promise<void>;
  /** downloads a Telegram file by id */
  downloadFile?(fileId: string): Promise<Uint8Array>;
}

export async function connectedAccounts(s: Services): Promise<Account[]> {
  if (!s.calendar) return [];
  const connected = await s.tokens.connected();
  const out: Account[] = [];
  for (const a of ACCOUNTS) {
    if (!connected.includes(`google:${a}` as const)) continue;
    const t = await s.tokens.get(`google:${a}` as const);
    if (!t?.meta.broken) out.push(a);
  }
  return out;
}

export interface EventsResult {
  events: CalEvent[];
  errors: string[];
  accounts: Account[];
}

/** Events from every connected calendar; one failing account does not hide the other. */
export async function listAllEvents(s: Services, fromISO: string, toISO: string): Promise<EventsResult> {
  const accounts = await connectedAccounts(s);
  if (!s.calendar || accounts.length === 0) throw new NotConnected('Google Calendar не підключено. Використайте /connect');
  const events: CalEvent[] = [];
  const errors: string[] = [];
  await Promise.all(
    accounts.map(async (a) => {
      try {
        events.push(...(await s.calendar!.list(a, fromISO, toISO)));
      } catch (e) {
        errors.push(`${a}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  events.sort((x, y) => new Date(x.start).getTime() - new Date(y.start).getTime());
  return { events, errors, accounts };
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
