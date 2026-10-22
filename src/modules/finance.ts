import type { FinanceEntry } from '../notion/repo.js';
import type { Settings } from '../store/settings.js';

export class FinanceError extends Error {}

const CURRENCY_ALIASES: Record<string, string> = {
  usd: 'USD', '$': 'USD', долар: 'USD', доларів: 'USD', долара: 'USD', доллар: 'USD', долларов: 'USD', бакс: 'USD',
  eur: 'EUR', '€': 'EUR', євро: 'EUR', евро: 'EUR',
  uah: 'UAH', '₴': 'UAH', грн: 'UAH', гривня: 'UAH', гривень: 'UAH', гривні: 'UAH',
  chf: 'CHF', франк: 'CHF', франків: 'CHF',
  pln: 'PLN', злотих: 'PLN', zł: 'PLN',
};

export function normalizeCurrency(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const key = input.trim().toLowerCase();
  return CURRENCY_ALIASES[key] ?? (/^[a-z]{3}$/i.test(key) ? key.toUpperCase() : fallback);
}

export interface FinanceInput {
  amount: number;
  currency?: string;
  kind: 'expense' | 'income';
  category: string;
  scope: 'personal' | 'project';
  project?: string;
  note?: string;
  /** YYYY-MM-DD */
  date: string;
}

/** Checks the entry against the client's category list and projects. Throws a message the assistant can relay. */
export function validateEntry(input: FinanceInput, settings: Settings): Omit<FinanceEntry, 'id'> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new FinanceError('Сума має бути додатним числом (напрям задає kind).');
  const allowed = settings.categories[input.kind];
  let category = input.category.trim();
  if (allowed.length) {
    const hit = allowed.find((c) => c.toLowerCase() === category.toLowerCase());
    if (!hit) throw new FinanceError(`Категорії «${category}» немає у списку. Доступні (${input.kind}): ${allowed.join(', ')}. Уточніть у користувача.`);
    category = hit;
  }
  let project = input.project?.trim();
  if (input.scope === 'project') {
    if (!project) throw new FinanceError('Для запису по проєкту потрібна назва проєкту.');
    if (settings.projects.length) {
      const hit = settings.projects.find((p) => p.toLowerCase() === project!.toLowerCase());
      if (!hit) throw new FinanceError(`Проєкту «${project}» немає. Доступні: ${settings.projects.join(', ')}.`);
      project = hit;
    }
  } else project = undefined;
  return {
    date: input.date,
    amount: Math.round(input.amount * 100) / 100,
    currency: normalizeCurrency(input.currency, settings.currency),
    kind: input.kind,
    category,
    scope: input.scope,
    project,
    note: input.note?.trim() ?? '',
  };
}

export interface CurrencyTotals {
  currency: string;
  expense: number;
  income: number;
  net: number;
  byCategory: Record<string, number>;
  byProject: Record<string, { expense: number; income: number }>;
  count: number;
}

const cents = (n: number) => Math.round(n * 100);

/** Sums in integer cents, per currency (no FX conversion: not in scope). The LLM never does arithmetic. */
export function summarize(entries: FinanceEntry[], filter: { scope?: 'personal' | 'project'; project?: string } = {}): CurrencyTotals[] {
  const acc = new Map<string, { exp: number; inc: number; cat: Record<string, number>; proj: Record<string, { e: number; i: number }>; n: number }>();
  for (const e of entries) {
    if (filter.scope && e.scope !== filter.scope) continue;
    if (filter.project && e.project?.toLowerCase() !== filter.project.toLowerCase()) continue;
    const a = acc.get(e.currency) ?? { exp: 0, inc: 0, cat: {}, proj: {}, n: 0 };
    const c = cents(e.amount);
    if (e.kind === 'expense') {
      a.exp += c;
      a.cat[e.category] = (a.cat[e.category] ?? 0) + c;
    } else a.inc += c;
    if (e.project) {
      const p = (a.proj[e.project] ??= { e: 0, i: 0 });
      if (e.kind === 'expense') p.e += c;
      else p.i += c;
    }
    a.n++;
    acc.set(e.currency, a);
  }
  return [...acc.entries()]
    .map(([currency, a]) => ({
      currency,
      expense: a.exp / 100,
      income: a.inc / 100,
      net: (a.inc - a.exp) / 100,
      byCategory: Object.fromEntries(Object.entries(a.cat).map(([k, v]) => [k, v / 100])),
      byProject: Object.fromEntries(Object.entries(a.proj).map(([k, v]) => [k, { expense: v.e / 100, income: v.i / 100 }])),
      count: a.n,
    }))
    .sort((x, y) => x.currency.localeCompare(y.currency));
}

export const money = (n: number, cur: string) => `${n.toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`;

export function formatSummary(totals: CurrencyTotals[], label: string): string {
  if (!totals.length) return `Фінанси за ${label}: записів немає.`;
  const lines = [`Фінанси за ${label}:`];
  for (const t of totals) {
    lines.push(`• ${t.currency}: витрати ${money(t.expense, t.currency)}, доходи ${money(t.income, t.currency)}, баланс ${money(t.net, t.currency)} (${t.count} запис.)`);
    const cats = Object.entries(t.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (cats.length) lines.push('  Витрати за категоріями: ' + cats.map(([c, v]) => `${c} ${money(v, t.currency)}`).join(', '));
    const projects = Object.entries(t.byProject);
    if (projects.length) lines.push('  За проєктами: ' + projects.map(([p, v]) => `${p} (−${money(v.expense, t.currency)} / +${money(v.income, t.currency)})`).join(', '));
  }
  return lines.join('\n');
}
