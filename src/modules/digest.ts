import { DateTime } from 'luxon';
import type { Services } from '../services.js';

/**
 * Long memory: once a day the previous day's conversation (Telegram + web + voice) is condensed into a few lines
 * — decisions, commitments, preferences, context — and stored as a `digest` memory. The prompt carries the last week.
 */
export async function digestDay(s: Services, dayIso: string): Promise<string | undefined> {
  const st = await s.settings.get();
  const day = DateTime.fromISO(dayIso, { zone: st.timezone });
  const msgs = await s.messages.between(s.cfg.OWNER_TELEGRAM_ID, day.startOf('day').toUTC().toISO()!, day.plus({ days: 1 }).startOf('day').toUTC().toISO()!);
  const meaningful = msgs.filter((m) => m.content.trim().length > 3);
  if (meaningful.length < 2) return undefined;
  const transcript = meaningful
    .map((m) => `${m.role === 'user' ? 'Власник' : 'Асистент'}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
    .slice(-12_000);
  const res = await s.llm.chat({
    model: s.cfg.OPENAI_DIGEST_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'Стисни розмову власника з особистим асистентом за день у 2–6 коротких пунктів українською для довгої пам’яті асистента. ' +
          'Лише корисне надалі: рішення, домовленості, обіцянки (хто, що, до коли), вподобання й правила власника, важливий контекст і настрій. ' +
          'Без світських розмов і без повторення технічних деталей підтверджень. Формат: кожен пункт з нового рядка, починається з «- ». ' +
          'Якщо нічого вартого пам’яті не було — відповідай одним символом «—».',
      },
      { role: 'user', content: `Дата: ${dayIso}\n${transcript}` },
    ],
  });
  const text = (res.content ?? '').trim();
  if (!text || text === '—' || text === '-') return undefined;
  await s.memory.remember(`Розмова ${day.setLocale('uk').toFormat('d LLLL')}`, text.slice(0, 1000), 'digest');
  return text;
}
