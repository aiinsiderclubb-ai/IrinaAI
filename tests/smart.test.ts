import { describe, expect, it } from 'vitest';
import { Agent, buildSystemPrompt } from '../src/agent/agent.js';
import { digestDay } from '../src/modules/digest.js';
import { readPagesText, clearContextCache } from '../src/notion/context.js';
import { makeEnv, say } from './helpers/services.js';

describe('daily conversation digest (long memory)', () => {
  it('condenses yesterday into a digest memory that the prompt carries, skips empty days', async () => {
    const env = await makeEnv({ now: '2026-10-24T01:00:00Z' }); // 04:00 Kyiv, next day
    const add = (role: string, content: string, at: string) =>
      env.db.query('INSERT INTO messages(chat_id, role, content, created_at) VALUES (42,$1,$2,$3)', [role, content, at]);
    await add('user', 'домовились з Андрієм: звіт для фонду до 1 листопада', '2026-10-23T09:00:00Z');
    await add('assistant', 'Зафіксувала.', '2026-10-23T09:00:05Z');
    await add('user', 'інший день', '2026-10-24T08:00:00Z');
    env.llm.script.push(say('- Звіт для фонду (Андрій) — до 1 листопада.'));
    expect(await digestDay(env.s, '2026-10-23')).toContain('Звіт для фонду');
    expect(env.llm.calls.at(-1)!.model).toBe('digest-model');
    const prompt = await buildSystemPrompt(env.s);
    expect(prompt).toContain('ПІДСУМКИ ПОПЕРЕДНІХ РОЗМОВ');
    expect(prompt).toContain('Звіт для фонду (Андрій)');
    expect(prompt.split('ЩО ТИ ПАМ’ЯТАЄШ')[1] ?? '').not.toContain('Звіт для фонду'); // digests are not mixed into facts
    expect(await digestDay(env.s, '2026-10-20')).toBeUndefined(); // nothing said that day
  });
});

describe('owner context from Notion (read-only)', () => {
  it('reads page blocks as text with GET only, caches, and lands in the prompt', async () => {
    clearContextCache();
    const env = await makeEnv({ settings: { notionContextPages: ['page-1'] } });
    const methods: string[] = [];
    env.s.notionApi = {
      async request(method: string, path: string) {
        methods.push(`${method} ${path.split('?')[0]}`);
        return {
          results: [
            { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Правила достовірності' }] } },
            { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Статус «Завершено» лише після підтвердженого результату' }] } },
            { type: 'paragraph', paragraph: { rich_text: [] } },
          ],
          has_more: false,
        };
      },
      async upload() {
        throw new Error('no');
      },
    } as never;
    const prompt = await buildSystemPrompt(env.s);
    expect(prompt).toContain('КОНТЕКСТ ВЛАСНИКА З NOTION');
    expect(prompt).toContain('- Статус «Завершено» лише після підтвердженого результату');
    await buildSystemPrompt(env.s);
    expect(methods).toEqual(['GET /v1/blocks/page-1/children']); // cached, and never anything but GET
    expect(await readPagesText(env.s.notionApi!, [])).toBe('');
  });
});

describe('prompt rules for a smarter agent', () => {
  it('search-before-asking, debrief splitting and learning from corrections are in the prompt; day brief also in text mode', async () => {
    const env = await makeEnv();
    env.calendar.add('work', { title: 'Нарада з фондом', start: '2026-10-23T11:00:00+03:00', end: '2026-10-23T12:00:00+03:00' });
    const p = await buildSystemPrompt(env.s, 'text');
    expect(p).toContain('СПЕРШУ ШУКАЙ, ПОТІМ ПИТАЙ');
    expect(p).toContain('waiting_add');
    expect(p).toContain('kind=preference');
    expect(p).toContain('СЬОГОДНІ');
    expect(p).toContain('Нарада з фондом');
  });

  it('history covers two days', async () => {
    const env = await makeEnv({ now: '2026-10-23T09:00:00Z' });
    await env.s.messages.add(42, 'user', 'вчорашнє');
    env.setNow('2026-10-24T20:00:00Z'); // 35 h later
    env.llm.script.push(say('ok'));
    await new Agent(env.s).handle(42, 'а що я казав учора?');
    expect(JSON.stringify(env.llm.calls[0]!.messages)).toContain('вчорашнє');
  });
});

describe('honesty and the owner\'s gender', () => {
  it('prompt marks unconnected sources and unknown data, and fixes the feminine address', async () => {
    const env = await makeEnv({ settings: { ownerName: 'Ірина', ownerGender: 'female' }, connectCalendars: false });
    env.s.notion = async () => {
      throw new Error('Notion не підключено');
    };
    const p = await buildSystemPrompt(env.s, 'voice');
    expect(p).toContain('ДЖЕРЕЛА ДАНИХ: задачі/рішення/фінанси (Notion) — НЕ підключено');
    expect(p).toContain('календар — НЕ підключено');
    expect(p).toContain('НЕВІДОМО (Notion недоступний)');
    expect(p).toContain('НІКОЛИ НЕ ВИГАДУЙ');
    expect(p).toContain('Власниця — жінка (Ірина)');
    expect(p.trim().endsWith('НАГАДУВАННЯ: до власниці — лише жіночий рід.')).toBe(true);
  });

  it('the recogniser echoing its own hint on silence is not treated as speech', async () => {
    const { isPhantomTranscript } = await import('../src/lib/wake.js');
    expect(isPhantomTranscript('Розмова українською з особистим асистентом Асистент.', 'Асистент')).toBe(true);
    expect(isPhantomTranscript('Дякую за перегляд!', 'Аріна')).toBe(true);
    expect(isPhantomTranscript('що в мене сьогодні?', 'Аріна')).toBe(false);
  });
});
