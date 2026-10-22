import { useState } from 'react';
import { api } from '../api';
import { go } from '../router';
import { dueLabel, longDate, time } from '../format';
import { IconCheck } from '../icons';
import type { Proposal, Task, Today } from '../types';
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

export function TodayScreen({ onChanged }: { onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad<Today>('/api/today');
  const pending = useLoad<{ items: Proposal[] }>('/api/pending');
  const [report, setReport] = useState<'morning' | 'evening' | null>(null);
  const complete = useCompleteTask(() => {
    void reload();
    onChanged();
  });

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorNote text={error} />;

  const conflictIds = new Set(data.conflicts.flat());
  const nowMs = Date.now();
  const nextIdx = data.events.findIndex((e) => !e.allDay && new Date(e.end).getTime() > nowMs);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{longDate(data.date)}</h1>
          <p>
            {data.events.filter((e) => !e.allDay).length} подій у календарі · {data.focus.length} задач на сьогодні
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setReport('morning')}>
            Ранковий звіт
          </button>
          <button className="btn" onClick={() => setReport('evening')}>
            Вечірній звіт
          </button>
          <button className="btn btn-primary" onClick={() => go('chat?ask=plan')}>
            Скласти план дня
          </button>
        </div>
      </div>

      {(pending.data?.items.length ?? 0) > 0 && (
        <section className="card card-pad stack" style={{ gap: 12 }}>
          <h2>Чекають вашого підтвердження</h2>
          {pending.data!.items.map((p) => (
            <ProposalCard
              key={p.id}
              p={p}
              onResolved={() => {
                void reload();
                onChanged();
              }}
            />
          ))}
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Розклад</h2>
            <span className="row">
              <span className="pill pill-work">робочий</span>
              <span className="pill pill-personal">особистий</span>
            </span>
          </div>
          <ErrorNote text={data.errors.calendar} />
          {data.events.length === 0 && !data.errors.calendar ? (
            <div className="empty">Подій немає — день вільний.</div>
          ) : (
            <ul className="timeline">
              {data.events.map((e, i) => (
                <li key={e.id} style={i === nextIdx ? { background: 'linear-gradient(90deg, var(--accent-soft), transparent 70%)', borderRadius: 8 } : undefined}>
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
                  <div className={`what bar ${e.account}`}>
                    <div className="title">{e.title}</div>
                    {e.location && <div className="muted" style={{ fontSize: 13 }}>{e.location}</div>}
                    {conflictIds.has(e.id) && <div className="conflict">Накладається з іншою подією</div>}
                  </div>
                </li>
              ))}
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
              <div className="empty">Нічого не очікуєте.</div>
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

          <section className="card">
            <div className="card-head">
              <h2>Дедлайни тижня</h2>
              <span className="count">{data.upcoming.length}</span>
            </div>
            {data.upcoming.length === 0 ? (
              <div className="empty">Найближчий тиждень вільний від дедлайнів.</div>
            ) : (
              <ul className="list">
                {data.upcoming.slice(0, 8).map((t) => (
                  <TaskRow key={t.id} t={t} today={data.date} onDone={complete} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {report && <ReportModal kind={report} onClose={() => setReport(null)} />}
    </div>
  );
}
