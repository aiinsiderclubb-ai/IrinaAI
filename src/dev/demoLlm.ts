import { DateTime } from 'luxon';
import type { ChatResult, Llm, LlmMessage } from '../integrations/openai.js';

const HELP =
  'Демо-режим без OpenAI: розумію лише кілька фраз. Спробуйте: «склади план дня», «які задачі на сьогодні?», ' +
  '«додай задачу: підготувати договір», «мінус 20 доларів таксі», «скільки я витратив цього місяця?». ' +
  'З ключем OPENAI_API_KEY асистент розумітиме будь-які запити.';

const call = (name: string, args: unknown): ChatResult => ({ content: null, toolCalls: [{ id: `demo-${name}-${Date.now()}`, name, arguments: JSON.stringify(args) }] });

/** Keyword router standing in for the model so the UI can be tried without any API key. */
export class DemoLlm implements Llm {
  constructor(private zone = 'Europe/Kyiv') {}

  async chat(args: { messages: LlmMessage[]; json?: boolean }): Promise<ChatResult> {
    if (args.json) return { content: '{}', toolCalls: [] };
    const last = args.messages[args.messages.length - 1]!;
    if (last.role === 'tool') return { content: summarizeTool(last.content), toolCalls: [] };
    const text = last.role === 'user' ? last.content.toLowerCase() : '';
    const now = DateTime.now().setZone(this.zone);

    const add = text.match(/(?:додай|створи)\s+задачу[:\s]+(.+)/i);
    if (add) return call('task_create', { title: add[1]!.trim().replace(/^./, (c) => c.toUpperCase()), project: 'Запуск продукту', due: now.plus({ days: 1 }).toISODate() });
    const minus = text.match(/мінус\s+(\d+(?:[.,]\d+)?)/);
    if (minus) return call('finance_record', { amount: Number(minus[1]!.replace(',', '.')), currency: 'USD', kind: 'expense', category: /їж|обід|кав/.test(text) ? 'Їжа' : 'Таксі', scope: 'personal', note: text.slice(0, 60) });
    if (/план/.test(text)) return call('plan_day', {});
    if (/витрат|фінанс|скільки/.test(text)) return call('finance_summary', { from: now.startOf('month').toISODate(), to: now.endOf('month').toISODate() });
    if (/задач|простроч|сьогодні/.test(text)) return call('tasks_list', { due_on_or_before: now.toISODate() });
    if (/подій|конференц/.test(text)) return call('events_search', {});
    return { content: HELP, toolCalls: [] };
  }

  async transcribe(): Promise<string> {
    return 'склади план дня';
  }

  async webSearch(): Promise<string> {
    const d = DateTime.now().plus({ weeks: 3 }).toISODate();
    return JSON.stringify([{ title: 'Demo AI Business Forum', why: 'Демо-подія для перевірки інтерфейсу', start: d, end: d, location: 'Онлайн', price: 'безкоштовно', url: 'https://example.com/demo-forum' }]);
  }
}

function summarizeTool(raw: string): string {
  let out: any;
  try {
    out = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (out?.status === 'awaiting_confirmation') return `Підготував: ${out.summary}. Підтвердьте нижче.`;
  if (out?.status === 'duplicate') return `Така задача вже є: «${out.existing.title}».`;
  if (out?.status === 'error') return `Не вийшло: ${out.note}`;
  if (out?.status === 'empty') return out.plan ?? 'Немає що планувати.';
  if (typeof out?.text === 'string') return out.text;
  if (Array.isArray(out)) return out.length ? out.map((t: any) => `• ${t.title}${t.due ? ` (до ${String(t.due).slice(0, 10)})` : ''}`).join('\n') : 'Нічого не знайдено.';
  return 'Готово.';
}
