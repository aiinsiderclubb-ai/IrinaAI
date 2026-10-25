import { useState } from 'react';
import { api } from '../api';
import { dueLabel, longDate, num, time } from '../format';
import { IconCheck } from '../icons';
import type { Proposal, Settings, SocialData, Task, Today } from '../types';
import { ErrorNote, Loading, ProposalCard, ReportModal, useLoad, useToast } from '../ui';

export function TaskRow({ t, today, onDone }: { t: Task; today: string; onDone: (t: Task) => void }) {
  const due = dueLabel(t.due, today);
  return (
    <li>
      <button className={`check ${t.done ? 'done' : ''}`} onClick={() => onDone(t)} disabled={t.done} title="Завершити" aria-label={`Завершити «${t.title}»`}>
        <IconCheck size={14} />
      </button>
      <div className="grow">
        <div className="title">{t.title}</div>
        <div className="meta">
          {t.project && <span>{t.project}</span>}
          {due && <span className={`pill pill-${due.tone}`}>{due.text}</span>}
          {t.priority && <span>{t.priority}</span>}
        </div>
      </div>
    </li>
  );
}

export function useCompleteTask(after: () => void) {
  const toast = useToast();
  return async (t: Task) => {
    if (!window.confirm(`Позначити задачу «${t.title}» завершеною?`)) return;
    try {
      const r = await api.post<{ ok: boolean; text: string }>(`/api/tasks/${t.id}/complete`);
      toast(r.text);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    after();
  };
}

const greeting = (h: number) => (h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Добрий день' : 'Добрий вечір');

function SocialTiles() {
  const { data } = useLoad<{ accounts: Array<{ data: SocialData; delta: Record<string, number> }> }>('/api/social');
  if (!data?.accounts.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Соцмережі</h2>
        <span className="count">7 днів</span>
      </div>
      <div className="stats" style={{ margin: '6px 22px 22px', gridTemplateColumns: `repeat(${data.accounts.length}, 1fr)` }}>
        {data.accounts.map(({ data: d, delta }) => {
          const key = d.platform === 'instagram' ? 'followers' : 'subscribers';
          const change = delta[key];
          const reach = d.period.reach ?? d.period.views;
          return (
            <div className="stat" key={d.platform}>
              <div className="k">{d.platform === 'instagram' ? 'Instagram' : 'YouTube'}</div>
              <div className="v">{num(d.totals[key] ?? 0)}</div>
              <div className={`d ${change && change < 0 ? 'down' : 'up'}`}>
                {change ? `${change > 0 ? '+' : ''}${num(change)} підписників` : 'без змін'}
                {reach !== undefined && <span className="muted"> · {num(reach)} {d.period.reach !== undefined ? 'охоплення' : 'переглядів'}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Day({ onChanged }: { onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad<Today>('/api/today');
  const pending = useLoad<{ items: Proposal[] }>('/api/pending');
  const settings = useLoad<Settings>('/api/settings');
  const [report, setReport] = useState<'morning' | 'evening' | null>(null);
  const [planning, setPlanning] = useState(false);
  const toast = useToast();
  const refresh = () => {
    void reload();
    void pending.reload();
    onChanged();
  };
  const complete = useCompleteTask(refresh);

  const planDay = async () => {
    setPlanning(true);
    try {
      const r = await api.post<{ text: string; proposals: Proposal[] }>('/api/chat', { text: 'Склади план мого дня на сьогодні за вільним часом.' });
      if (!r.proposals.length) toast(r.text || 'Немає що планувати');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  if (loading && !data) return <Loading text="Збираю день…" />;
  if (!data) return <ErrorNote text={error} />;

  const conflictIds = new Set(data.conflicts.flat());
  const nowMs = Date.now();
  const timed = data.events.filter((e) => !e.allDay);
  const owner = settings.data?.ownerName;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{longDate(data.date)}</div>
          <h1>
            {greeting(Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: data.timezone })))}
            {owner ? `, ${owner}` : ''}
          </h1>
          <p>
            {timed.length} подій · {data.focus.length} задач на сьогодні · {data.waiting.length} очікую
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setReport('morning')}>
            Ранковий звіт
          </button>
          <button className="btn" onClick={() => setReport('evening')}>
            Вечірній звіт
          </button>
          <button className="btn btn-primary" onClick={planDay} disabled={planning}>
            {planning ? 'Планую…' : 'Скласти план дня'}
          </button>
        </div>
      </div>

      {(pending.data?.items.length ?? 0) > 0 && (
        <section className="stack" style={{ gap: 12 }}>
          <h2>Чекають підтвердження</h2>
          <div className="pending-strip">
            {pending.data!.items.map((p) => (
              <ProposalCard key={p.id} p={p} projects={settings.data?.projects} onResolved={refresh} />
            ))}
          </div>
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Розклад</h2>
            <span className="row" style={{ gap: 6 }}>
              <span className="pill pill-work">робочий</span>
              <span className="pill pill-personal">особистий</span>
            </span>
          </div>
          <ErrorNote text={data.errors.calendar} />
          {data.events.length === 0 && !data.errors.calendar ? (
            <div className="empty">Подій немає — день вільний.</div>
          ) : (
            <ul className="timeline">
              {data.events.map((e) => {
                const past = !e.allDay && new Date(e.end).getTime() <= nowMs;
                const now = !e.allDay && !past && new Date(e.start).getTime() <= nowMs;
                const focus = e.title.startsWith('🎯');
                return (
                  <li key={e.id} className={past ? 'past' : now ? 'now' : undefined}>
                    <div className="when">
                      {e.allDay ? (
                        'весь день'
                      ) : (
                        <>
                          <b>{time(e.start, data.timezone)}</b>
                          {time(e.end, data.timezone)}
                        </>
                      )}
                    </div>
                    <div className={`what bar ${focus ? 'focus' : e.account}`}>
                      <div className="title">{focus ? e.title.replace(/^🎯\s*/, '') : e.title}</div>
                      {(e.location || focus) && <div className="muted" style={{ fontSize: 13 }}>{focus ? 'фокус-блок' : e.location}</div>}
                      {conflictIds.has(e.id) && <div className="conflict">накладка</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Фокус дня</h2>
              <span className="count">{data.focus.length}</span>
            </div>
            <ErrorNote text={data.errors.tasks} />
            {data.focus.length === 0 && !data.errors.tasks ? (
              <div className="empty">На сьогодні задач із дедлайном немає.</div>
            ) : (
              <ul className="list">
                {data.focus.map((t) => (
                  <TaskRow key={t.id} t={t} today={data.date} onDone={complete} />
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Очікую відповіді</h2>
              <span className="count">{data.waiting.length}</span>
            </div>
            <ErrorNote text={data.errors.waiting} />
            {data.waiting.length === 0 ? (
              <div className="empty">Нічого не очікуєш.</div>
            ) : (
              <ul className="list">
                {data.waiting.map((w) => {
                  const due = dueLabel(w.due, data.date);
                  return (
                    <li key={w.id}>
                      <div className="grow">
                        <div className="title">{w.title}</div>
                        <div className="meta">
                          {w.from && <span>від {w.from}</span>}
                          {w.project && <span>{w.project}</span>}
                          {due && <span className={`pill pill-${due.tone}`}>{due.text}</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {data.upcoming.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>Дедлайни тижня</h2>
                <span className="count">{data.upcoming.length}</span>
              </div>
              <ul className="list">
                {data.upcoming.slice(0, 6).map((t) => (
                  <TaskRow key={t.id} t={t} today={data.date} onDone={complete} />
                ))}
              </ul>
            </section>
          )}

          <SocialTiles />
        </div>
      </div>
      {report && <ReportModal kind={report} onClose={() => setReport(null)} />}
    </div>
  );
}
