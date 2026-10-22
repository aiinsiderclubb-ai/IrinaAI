import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Llm } from '../integrations/openai.js';
import type { Settings } from '../store/settings.js';

export interface FoundEvent {
  title: string;
  why: string;
  start?: string;
  end?: string;
  location?: string;
  price?: string;
  url: string;
}

export function buildSearchPrompt(settings: Settings, today: string): string {
  return [
    `Сьогодні ${today}. Знайди в інтернеті майбутні конференції та професійні події (найближчі 3 місяці).`,
    `Теми: ${settings.eventsTopics.join('; ')}.`,
    `Географія: ${settings.eventsGeo || 'будь-яка, включно з онлайн'}.`,
    'Лише реальні події з офіційним посиланням. Не вигадуй дат і цін: якщо невідомо — залиш порожнім.',
    'Поверни ТІЛЬКИ JSON-масив до 8 об’єктів без пояснень:',
    '[{"title":"","why":"1 речення, чому варто піти","start":"YYYY-MM-DD","end":"YYYY-MM-DD","location":"","price":"","url":"https://..."}]',
  ].join('\n');
}

/** Tolerant parser: finds the first JSON array in the model's answer and keeps only complete items. */
export function parseEvents(text: string): FoundEvent[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: FoundEvent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!/^https?:\/\//.test(url) || !title) continue;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    out.push({ title, why: str(o.why) ?? '', start: str(o.start), end: str(o.end), location: str(o.location), price: str(o.price), url });
  }
  return out;
}

export function eventKey(e: FoundEvent): string {
  let host = '';
  let path = '';
  try {
    const u = new URL(e.url);
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname.replace(/\/$/, '');
  } catch {
    host = e.url;
  }
  return createHash('sha1').update(`${host}${path}|${e.start ?? ''}`).digest('hex').slice(0, 20);
}

/** Returns only events not shown before, and remembers them. */
export async function filterNew(db: Db, events: FoundEvent[]): Promise<FoundEvent[]> {
  const fresh: FoundEvent[] = [];
  const batch = new Set<string>();
  for (const e of events) {
    const key = eventKey(e);
    if (batch.has(key)) continue;
    batch.add(key);
    const { rows } = await db.query('INSERT INTO seen_events(key, title) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key', [key, e.title]);
    if (rows.length) fresh.push(e);
  }
  return fresh;
}

export function formatEvents(events: FoundEvent[]): string {
  if (!events.length) return 'Нових подій за вашими темами цього разу не знайдено.';
  const lines = ['Підбірка подій:'];
  for (const e of events) {
    const dates = e.start ? (e.end && e.end !== e.start ? `${e.start} – ${e.end}` : e.start) : 'дати уточнюйте';
    lines.push(
      `\n• ${e.title}\n  ${e.why}\n  Дата: ${dates}${e.location ? ` · ${e.location}` : ''}\n  Вартість: ${e.price ?? 'не вказано'}\n  ${e.url}`,
    );
  }
  lines.push('\nДані з відкритих джерел, перед реєстрацією перевірте їх за посиланням.');
  return lines.join('\n');
}

export async function searchEvents(deps: { db: Db; llm: Llm; settings: Settings; today: string }): Promise<{ fresh: FoundEvent[]; total: number }> {
  if (!deps.settings.eventsTopics.length) throw new Error('Теми для пошуку подій не задано (settings.eventsTopics)');
  const answer = await deps.llm.webSearch(buildSearchPrompt(deps.settings, deps.today));
  const found = parseEvents(answer);
  const fresh = await filterNew(deps.db, found);
  return { fresh, total: found.length };
}
