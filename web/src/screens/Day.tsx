import { Fragment, useState } from 'react';
import { api } from '../api';
import { dueLabel, longDate, num, time } from '../format';
import { CountUp, DayDial, PanelHead, Ring, useNow } from '../hud';
import { IconCheck } from '../icons';

function NowLine({ timeZone }: { timeZone: string }) {
  const now = useNow(30_000);
  return (
    <li className="now-line" aria-label="Зараз">
      <span className="now-tag">{now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone })}</span>
      <span className="now-rule" />
    </li>
  );
}
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

  const pendingCount = pending.data?.items.length ?? 0;
  const late = [...data.focus, ...data.upcoming].filter((t) => dueLabel(t.due, data.date)?.tone === 'late').length;
  const leftEvents = timed.filter((e) => new Date(e.end).getTime() > nowMs).length;
  // where the NOW line goes: before the first event that has not ended yet
  const nowIndex = data.events.findIndex((e) => !e.allDay && new Date(e.end).getTime() > nowMs);
  const showNowLine = timed.length > 0 && !data.events.some((e) => !e.allDay && new Date(e.start).getTime() <= nowMs && new Date(e.end).getTime() > nowMs);

  return (
    <div className="page">
      <section className="card hero">
        <DayDial events={data.events} date={data.date} timeZone={data.timezone} workday={settings.data ? { start: settings.data.workdayStart, end: settings.data.workdayEnd } : undefined} />
        <div className="hero-main">
          <div>
            <div className="eyebrow">{longDate(data.date)}</div>
            <h1>
              {greeting(Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: data.timezone })))}
              {owner ? `, ${owner}` : ''}
            </h1>
          </div>
          <div className="metrics">
            <a className="metric" href="#/day" onClick={(e) => (e.preventDefault(), document.querySelector('.timeline')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))}>
              <Ring value={timed.length ? leftEvents / timed.length : 0} size={42} stroke={3}>
                {null}
              </Ring>
              <div>
                <div className="mv">
                  <CountUp value={leftEvents} />
                  <span className="muted" style={{ fontSize: 16 }}>/{timed.length}</span>
                </div>
                <div className="mk">подій попереду</div>
              </div>
            </a>
            <a className="metric" href="#/tasks">
              <Ring value={Math.min(1, data.focus.length / 8)} size={42} stroke={3} tone="violet">
                {null}
              </Ring>
              <div>
                <div className="mv">
                  <CountUp value={data.focus.length} />
                </div>
                <div className="mk">задач на сьогодні</div>
              </div>
            </a>
            <div className={`metric ${late ? 'danger' : ''}`}>
              <Ring value={late ? 1 : 0} size={42} stroke={3} tone={late ? 'danger' : 'ok'}>
                {null}
              </Ring>
              <div>
                <div className="mv">
                  <CountUp value={late} />
                </div>
                <div className="mk">прострочено</div>
              </div>
            </div>
            <div className={`metric ${pendingCount ? 'warn' : ''}`}>
              <Ring value={pendingCount ? 1 : 0} size={42} stroke={3} tone="warn">
                {null}
              </Ring>
              <div>
                <div className="mv">
                  <CountUp value={pendingCount} />
                </div>
                <div className="mk">на підтвердження</div>
              </div>
            </div>
          </div>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={planDay} disabled={planning}>
              {planning ? 'Планую…' : 'Скласти план дня'}
            </button>
            <button className="btn" onClick={() => setReport('morning')}>
              Ранковий звіт
            </button>
            <button className="btn" onClick={() => setReport('evening')}>
              Вечірній звіт
            </button>
          </div>
        </div>
      </section>

      {pendingCount > 0 && (
        <section className="stack" style={{ gap: 12 }}>
          <h2>
            <span className="panel-tick" aria-hidden="true" />
            Чекають підтвердження
          </h2>
          <div className="pending-strip">
            {pending.data!.items.map((p) => (
              <ProposalCard key={p.id} p={p} projects={settings.data?.projects} onResolved={refresh} />
            ))}
          </div>
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <PanelHead
            title="Розклад"
            code={`${timed.length} подій`}
            right={
              <span className="row" style={{ gap: 6 }}>
                <span className="pill pill-work">робочий</span>
                <span className="pill pill-personal">особистий</span>
              </span>
            }
          />
          <ErrorNote text={data.errors.calendar} />
          {data.events.length === 0 && !data.errors.calendar ? (
            <div className="empty">Подій немає — день вільний.</div>
          ) : (
            <ul className="timeline">
              {data.events.map((e, i) => {
                const past = !e.allDay && new Date(e.end).getTime() <= nowMs;
                const now = !e.allDay && !past && new Date(e.start).getTime() <= nowMs;
                const focus = e.title.startsWith('🎯');
                return (
                  <Fragment key={e.id}>
                  {showNowLine && i === nowIndex && <NowLine timeZone={data.timezone} />}
                  <li className={past ? 'past' : now ? 'now' : undefined}>
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
                  </Fragment>
                );
              })}
              {showNowLine && nowIndex === -1 && <NowLine timeZone={data.timezone} />}
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
