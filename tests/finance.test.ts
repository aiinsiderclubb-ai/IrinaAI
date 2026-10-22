import { describe, expect, it } from 'vitest';
import { FinanceError, formatSummary, normalizeCurrency, summarize, validateEntry } from '../src/modules/finance.js';
import { DEFAULT_SETTINGS } from '../src/store/settings.js';
import type { FinanceEntry } from '../src/notion/repo.js';

const settings = { ...DEFAULT_SETTINGS('Europe/Kyiv'), projects: ['Alpha'], categories: { expense: ['Таксі', 'Їжа'], income: ['Клієнт'] } };
const base = { amount: 45, kind: 'expense' as const, category: 'таксі', scope: 'personal' as const, date: '2026-10-23' };

describe('validateEntry', () => {
  it('normalises category, currency and drops project for personal entries', () => {
    expect(validateEntry({ ...base, currency: 'долара', project: 'Alpha', note: 'аеропорт' }, settings)).toEqual({
      date: '2026-10-23', amount: 45, currency: 'USD', kind: 'expense', category: 'Таксі', scope: 'personal', project: undefined, note: 'аеропорт',
    });
  });
  it('rejects unknown category with the allowed list, unknown project, bad amount', () => {
    expect(() => validateEntry({ ...base, category: 'Яхти' }, settings)).toThrow(/Таксі, Їжа/);
    expect(() => validateEntry({ ...base, scope: 'project', project: 'Zeta' }, settings)).toThrow(FinanceError);
    expect(() => validateEntry({ ...base, scope: 'project' }, settings)).toThrow(/проєкт/);
    expect(() => validateEntry({ ...base, amount: -5 }, settings)).toThrow(FinanceError);
  });
  it('currency aliases', () => {
    expect(normalizeCurrency('грн', 'USD')).toBe('UAH');
    expect(normalizeCurrency('€', 'USD')).toBe('EUR');
    expect(normalizeCurrency(undefined, 'USD')).toBe('USD');
    expect(normalizeCurrency('chf', 'USD')).toBe('CHF');
  });
});

describe('summarize', () => {
  const e = (amount: number, kind: 'expense' | 'income', extra: Partial<FinanceEntry> = {}): FinanceEntry => ({
    id: String(Math.random()), date: '2026-10-23', amount, currency: 'USD', kind, category: 'Таксі', scope: 'personal', note: '', ...extra,
  });
  it('sums in cents without float drift and keeps currencies apart', () => {
    const totals = summarize([e(0.1, 'expense'), e(0.2, 'expense'), e(1000, 'income', { category: 'Клієнт', scope: 'project', project: 'Alpha' }), e(50, 'expense', { currency: 'EUR' })]);
    const usd = totals.find((t) => t.currency === 'USD')!;
    expect(usd.expense).toBe(0.3);
    expect(usd.income).toBe(1000);
    expect(usd.net).toBe(999.7);
    expect(usd.byProject.Alpha).toEqual({ expense: 0, income: 1000 });
    expect(totals.find((t) => t.currency === 'EUR')!.expense).toBe(50);
  });
  it('filters by scope/project; period total equals the sum of its records', () => {
    const entries = [e(10, 'expense'), e(20, 'expense', { scope: 'project', project: 'Alpha' }), e(5, 'expense', { scope: 'project', project: 'Beta' })];
    expect(summarize(entries, { scope: 'personal' })[0]!.expense).toBe(10);
    expect(summarize(entries, { project: 'alpha' })[0]!.expense).toBe(20);
    expect(summarize(entries)[0]!.expense).toBe(35);
    expect(formatSummary(summarize(entries), '2026-10')).toContain('35');
    expect(formatSummary([], 'x')).toContain('записів немає');
  });
});
