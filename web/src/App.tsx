import { useCallback, useEffect, useState } from 'react';
import { go, useHash } from './router';
import { api, UNAUTHORIZED } from './api';
import { IconChat, IconLogo, IconMic, IconMoney, IconSettings, IconSocial, IconTasks, IconToday } from './icons';
import { Chat } from './screens/Chat';
import { Finance } from './screens/Finance';
import { Login } from './screens/Login';
import { SettingsScreen } from './screens/Settings';
import { Social } from './screens/Social';
import { Tasks } from './screens/Tasks';
import { TodayScreen } from './screens/Today';
import { Voice } from './screens/Voice';
import { useNudges } from './nudges';
import { Loading, ToastHost } from './ui';

const ROUTES = [
  { path: 'today', label: 'Сьогодні', short: 'Сьогодні', icon: IconToday },
  { path: 'voice', label: 'Голос', short: 'Голос', icon: IconMic },
  { path: 'chat', label: 'Чат', short: 'Чат', icon: IconChat },
  { path: 'tasks', label: 'Задачі', short: 'Задачі', icon: IconTasks },
  { path: 'finance', label: 'Фінанси', short: 'Фінанси', icon: IconMoney },
  { path: 'social', label: 'Соцмережі', short: 'Метрики', icon: IconSocial },
  { path: 'settings', label: 'Налаштування', short: 'Опції', icon: IconSettings },
] as const;
type Route = (typeof ROUTES)[number]['path'];

export function App() {
  const [auth, setAuth] = useState<{ ok: boolean; password: boolean } | null>(null);
  const [pending, setPending] = useState(0);
  const { route, params } = useHash();

  const checkAuth = useCallback(async () => {
    const me = await api.get<{ authenticated: boolean; passwordLogin: boolean }>('/api/auth/me').catch(() => ({ authenticated: false, passwordLogin: false }));
    setAuth({ ok: me.authenticated, password: me.passwordLogin });
  }, []);

  useEffect(() => {
    void checkAuth();
    const on = () => setAuth((a) => (a ? { ...a, ok: false } : a));
    window.addEventListener(UNAUTHORIZED, on);
    return () => window.removeEventListener(UNAUTHORIZED, on);
  }, [checkAuth]);

  const refreshPending = useCallback(() => {
    api.get<{ items: unknown[] }>('/api/pending').then((r) => setPending(r.items.length)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!auth?.ok) return;
    refreshPending();
    const t = setInterval(refreshPending, 30_000);
    return () => clearInterval(t);
  }, [auth?.ok, refreshPending, route]);

  useNudges(Boolean(auth?.ok));

  if (!auth) return <Loading />;
  if (!auth.ok || route === 'login')
    return (
      <ToastHost>
        <Login
          token={params.get('token')}
          passwordLogin={auth.password}
          onDone={() => {
            setAuth({ ...auth, ok: true });
            go('today');
          }}
        />
      </ToastHost>
    );

  const current: Route = (ROUTES.find((r) => r.path === route)?.path ?? 'today') as Route;
  return (
    <ToastHost>
      <div className="shell">
        <nav className="side" aria-label="Розділи">
          <div className="brand">
            <span className="brand-mark">
              <IconLogo size={18} />
            </span>
            Асистент
          </div>
          {ROUTES.map(({ path, label, short, icon: Icon }) => (
            <a key={path} href={`#/${path}`} className={`nav-item ${current === path ? 'active' : ''}`} aria-current={current === path ? 'page' : undefined}>
              <Icon />
              <span className="label-long">{label}</span>
              <span className="label-short">{short}</span>
              {path === 'chat' && pending > 0 && <span className="nav-badge">{pending}</span>}
            </a>
          ))}
          <div className="side-foot">Також доступний у Telegram</div>
        </nav>
        <main className="main">
          {current === 'today' && <TodayScreen onChanged={refreshPending} />}
          {current === 'voice' && <Voice onChanged={refreshPending} />}
          {current === 'chat' && <Chat onChanged={refreshPending} />}
          {current === 'tasks' && <Tasks />}
          {current === 'finance' && <Finance />}
          {current === 'social' && <Social />}
          {current === 'settings' && <SettingsScreen onLogout={() => setAuth({ ...auth, ok: false })} />}
        </main>
      </div>
    </ToastHost>
  );
}
