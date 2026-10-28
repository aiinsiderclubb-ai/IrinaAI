import type { Db } from '../db/index.js';
import type { NotionSchema } from '../notion/schema.js';
import { kvGet, kvSet } from './kv.js';

export interface Settings {
  timezone: string;
  /** the assistant's own name; also the wake word in hands-free voice mode */
  assistantName: string;
  /** how the assistant addresses the owner ("ти" + name) */
  ownerName: string;
  language: 'uk' | 'ru' | 'en';
  morningTime: string;
  eveningTime: string;
  /** OpenAI voice id (see OPENAI_VOICES); ignored when ElevenLabs is configured */
  ttsVoice: string;
  /** delivery preset (see VOICE_STYLES) */
  ttsStyle: string;
  /** ElevenLabs voice id (see ELEVEN_VOICES); used when an ElevenLabs key is set */
  elevenVoice: string;
  /** mirror = voice in -> voice out */
  voiceReplies: 'mirror' | 'always' | 'never';
  workdayStart: string;
  workdayEnd: string;
  /** calendar that receives blocks from "plan my day" */
  planCalendar: 'work' | 'personal';
  /** work<->personal mirror shows real titles instead of "Зайнято" */
  mirrorDetails: boolean;
  projects: string[];
  categories: { expense: string[]; income: string[] };
  currency: string;
  eventsTopics: string[];
  eventsGeo: string;
  /** 1 = Monday ... 7 = Sunday */
  eventsWeekday: number;
  eventsTime: string;
  /** owner's Notion pages read into the prompt (read-only), e.g. «Управлінський центр» */
  notionContextPages: string[];
  notion?: NotionSchema;
}

export const DEFAULT_SETTINGS = (timezone: string): Settings => ({
  timezone,
  assistantName: 'Асистент',
  ownerName: '',
  language: 'uk',
  morningTime: '08:00',
  eveningTime: '20:00',
  voiceReplies: 'mirror',
  ttsVoice: 'coral',
  ttsStyle: 'natural',
  elevenVoice: 'yMBZR4SLoc24wOJLWAB2',
  workdayStart: '09:00',
  workdayEnd: '19:00',
  planCalendar: 'work',
  mirrorDetails: false,
  projects: [],
  categories: { expense: [], income: [] },
  currency: 'USD',
  eventsTopics: [],
  eventsGeo: '',
  eventsWeekday: 1,
  eventsTime: '09:00',
  notionContextPages: [],
});

export class SettingsStore {
  private cache?: Settings;
  constructor(
    private db: Db,
    private defaults: Settings,
  ) {}

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const stored = await kvGet<Partial<Settings>>(this.db, 'settings');
    this.cache = { ...this.defaults, ...stored };
    return this.cache;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await kvSet(this.db, 'settings', next);
    this.cache = next;
    return next;
  }
}
