import { useState } from 'react';
import { money } from '../format';
import { IconChevronL, IconChevronR } from '../icons';
import type { CurrencyTotals, FinanceEntry } from '../types';
import { ErrorNote, Loading, useLoad } from '../ui';

const monthRange = (offset: number) => {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const iso = (x: Date) => x.toLocaleDateString('sv-SE');
  const label = first.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
  return { from: iso(first), to: iso(last), label: label.charAt(0).toUpperCase() + label.slice(1) };
};

export function Finance() {
  const [offset, setOffset] = useState(0);
  const [scope, setScope] = useState<'all' | 'personal' | 'project'>('all');
  const range = monthRange(offset);
  const { data, error, loading } = useLoad<{ totals: CurrencyTotals[]; entries: FinanceEntry[] }>(`/api/finance?from=${range.from}&to=${range.to}`);
  const entries = (data?.entries ?? []).filter((e) => scope === 'all' || e.scope === scope);

  // per-scope totals are recomputed from the rows the server returned (already exact to the cent)
  const totals = scope === 'all' ? (data?.totals ?? []) : recompute(entries);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Фінанси</h1>
          <p>Записи з таблиці «Фінанси». Додавайте фразою асистенту: «мінус 45 доларів, таксі, особисте».</p>
        </div>
        <div className="row">
          <div className="seg" role="tablist">
            {(['all', 'personal', 'project'] as const).map((s) => (
              <button key={s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)} role="tab" aria-selected={scope === s}>
                {s === 'all' ? 'Усе' : s === 'personal' ? 'Особисте' : 'Проєкти'}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn btn-icon btn-sm" onClick={() => setOffset(offset - 1)} aria-label="Попередній місяць">
              <IconChevronL size={18} />
            </button>
            <b style={{ minWidth: 140, textAlign: 'center' }}>{range.label}</b>
            <button className="btn btn-icon btn-sm" onClick={() => setOffset(offset + 1)} disabled={offset >= 0} aria-label="Наступний місяць">
              <IconChevronR size={18} />
            </button>
          </div>
        </div>
      </div>

      {loading && !data && <Loading />}
      <ErrorNote text={error} />
      {data && totals.length === 0 && <div className="card empty">За цей період записів немає.</div>}

      {totals.map((t) => {
        const cats = Object.entries(t.byCategory).sort((a, b) => b[1] - a[1]);
        const max = cats[0]?.[1] ?? 1;
        return (
          <section key={t.currency} className="stack" style={{ gap: 14 }}>
            <div className="stats">
              <div className="stat">
                <div className="k">Витрати, {t.currency}</div>
                <div className="v">{money(t.expense, t.currency)}</div>
              </div>
              <div className="stat">
                <div className="k">Доходи, {t.currency}</div>
                <div className="v">{money(t.income, t.currency)}</div>
              </div>
              <div className="stat">
                <div className="k">Баланс</div>
                <div className={`v ${t.net < 0 ? 'neg' : t.net > 0 ? 'pos' : ''}`}>{money(t.net, t.currency)}</div>
              </div>
            </div>
            {cats.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h2>Витрати за категоріями</h2>
                  <span className="count">{t.count} записів</span>
                </div>
                <div className="bars">
                  {cats.map(([c, v]) => (
                    <div className="bar-row" key={c}>
                      <span>{c}</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
                      </div>
                      <span className="amt">{money(v, t.currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}

      {entries.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Записи</h2>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Категорія</th>
                  <th>Проєкт</th>
                  <th>Нотатка</th>
                  <th className="r">Сума</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(`${e.date}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })}</td>
                    <td>{e.category}</td>
                    <td className="muted">{e.scope === 'personal' ? 'особисте' : e.project}</td>
                    <td className="muted">{e.note}</td>
                    <td className="r" style={{ color: e.kind === 'income' ? 'var(--ok)' : undefined, fontWeight: 560 }}>
                      {e.kind === 'income' ? '+' : '−'}
                      {money(e.amount, e.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function recompute(entries: FinanceEntry[]): CurrencyTotals[] {
  const by = new Map<string, { exp: number; inc: number; cat: Record<string, number>; n: number }>();
  for (const e of entries) {
    const a = by.get(e.currency) ?? { exp: 0, inc: 0, cat: {}, n: 0 };
    const c = Math.round(e.amount * 100);
    if (e.kind === 'expense') {
      a.exp += c;
      a.cat[e.category] = (a.cat[e.category] ?? 0) + c;
    } else a.inc += c;
    a.n++;
    by.set(e.currency, a);
  }
  return [...by.entries()].map(([currency, a]) => ({
    currency,
    expense: a.exp / 100,
    income: a.inc / 100,
    net: (a.inc - a.exp) / 100,
    byCategory: Object.fromEntries(Object.entries(a.cat).map(([k, v]) => [k, v / 100])),
    byProject: {},
    count: a.n,
  }));
}
