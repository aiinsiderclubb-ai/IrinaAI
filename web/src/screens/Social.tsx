import { go } from '../router';
import { num } from '../format';
import type { SocialData } from '../types';
import { ErrorNote, Loading, useLoad } from '../ui';

const LABELS: Record<string, string> = {
  followers: 'Підписники', following: 'Підписки', posts: 'Публікації', subscribers: 'Підписники', views: 'Перегляди', videos: 'Відео',
  reach: 'Охоплення', accounts_engaged: 'Залучені акаунти', total_interactions: 'Взаємодії', profile_views: 'Перегляди профілю',
  estimatedMinutesWatched: 'Хвилин перегляду', averageViewDuration: 'Сер. перегляд, с', subscribersGained: 'Нові підписники',
  subscribersLost: 'Відписки', likes: 'Лайки', comments: 'Коментарі', saved: 'Збереження', shares: 'Поширення',
};
const label = (k: string) => LABELS[k] ?? k;
// Postgres jsonb does not keep key order: show the headline numbers first
const ORDER = ['followers', 'subscribers', 'views', 'reach', 'posts', 'videos', 'following'];
const ordered = (o: Record<string, number>) => Object.entries(o).sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99));

export function Social() {
  const { data, error, loading } = useLoad<{ accounts: Array<{ data: SocialData; delta: Record<string, number> }> }>('/api/social');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Соцмережі</h1>
          <p>Щоденні знімки з офіційних API (лише читання). Свіжі цифри — запитайте асистента.</p>
        </div>
        <button className="btn" onClick={() => go('chat')}>
          Запитати асистента
        </button>
      </div>
      {loading && !data && <Loading />}
      <ErrorNote text={error} />
      {data && data.accounts.length === 0 && (
        <div className="card card-pad">
          <h2>Даних ще немає</h2>
          <p className="muted">Підключіть Instagram і YouTube у налаштуваннях — перший знімок з’явиться вночі або після запиту асистенту.</p>
          <button className="btn" onClick={() => go('settings')}>
            Відкрити налаштування
          </button>
        </div>
      )}
      {data?.accounts.map(({ data: d, delta }) => (
        <section key={d.platform} className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: 18 }}>
              {d.platform === 'instagram' ? 'Instagram' : 'YouTube'} <span className="muted">· {d.account}</span>
            </h2>
            <span className="muted" style={{ fontSize: 13 }}>
              знімок {new Date(d.takenAt).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="stats">
            {ordered(d.totals).map(([k, v]) => (
              <div className="stat" key={k}>
                <div className="k">{label(k)}</div>
                <div className="v">{num(v)}</div>
                {delta[k] ? <div className={`d ${delta[k]! > 0 ? 'up' : 'down'}`}>{delta[k]! > 0 ? '+' : ''}{num(delta[k]!)} за 7 дн.</div> : null}
              </div>
            ))}
          </div>
          {Object.keys(d.period).length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>За {d.periodDays} днів</h2>
              </div>
              <ul className="list">
                {ordered(d.period).map(([k, v]) => (
                  <li key={k}>
                    <span className="grow">{label(k)}</span>
                    <b>{num(v)}</b>
                  </li>
                ))}
              </ul>
              {d.unavailable.length > 0 && <div className="empty">API не віддає для цього акаунта: {d.unavailable.map(label).join(', ')}</div>}
            </div>
          )}
          {d.posts.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Останні публікації</h2>
              </div>
              <ul className="list">
                {d.posts.map((p, i) => (
                  <li key={i}>
                    <div className="grow">
                      <div className="title">{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title || 'Без назви'}</a> : p.title || 'Без назви'}</div>
                      <div className="meta">
                        {Object.entries(p.metrics).map(([k, v]) => (
                          <span key={k}>
                            {label(k)} {num(v)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
