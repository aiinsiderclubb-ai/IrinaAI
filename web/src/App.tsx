import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { go, useHash } from './router';
import { api, UNAUTHORIZED } from './api';
import { IconLogo, IconMoney, IconOrb, IconSettings, IconTasks, IconToday } from './icons';
import { Finance } from './screens/Finance';
import { Login } from './screens/Login';
import { SettingsScreen } from './screens/Settings';
import { Tasks } from './screens/Tasks';
import { Day } from './screens/Day';
// three.js is heavy: load the core only when it is opened
const Core = lazy(() => import('./screens/Core').then((m) => ({ default: m.Core })));
import { useNudges } from './nudges';
import { Loading, ToastHost } from './ui';

const ROUTES = [
  { path: 'core', label: 'Ядро', icon: IconOrb },
  { path: 'day', label: 'День', icon: IconToday },
  { path: 'tasks', label: 'Задачі', icon: IconTasks },
  { path: 'finance', label: 'Фінанси', icon: IconMoney },
  { path: 'settings', label: 'Опції', icon: IconSettings },
] as const;
/** old links keep working */
const ALIASES: Record<string, string> = { voice: 'core', today: 'day', chat: 'core', social: 'day' };
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
            go('core');
          }}
        />
      </ToastHost>
    );

  const resolved = ALIASES[route] ?? route;
  const current: Route = (ROUTES.find((r) => r.path === resolved)?.path ?? 'core') as Route;
  return (
    <ToastHost>
      <div className={`shell ${current === 'core' ? 'shell-core' : ''}`}>
        <nav className="side" aria-label="Розділи">
          <a className="brand" href="#/core" aria-label="Ядро">
            <span className="brand-mark">
              <IconLogo size={18} />
            </span>
          </a>
          {ROUTES.map(({ path, label, icon: Icon }) => (
            <a key={path} href={`#/${path}`} className={`nav-item ${current === path ? 'active' : ''}`} aria-current={current === path ? 'page' : undefined}>
              <Icon />
              <span>{label}</span>
              {path === 'day' && pending > 0 && <span className="nav-badge">{pending}</span>}
            </a>
          ))}
        </nav>
        <main className={current === 'core' ? 'main main-full' : 'main'}>
          {current === 'core' && (
            <Suspense fallback={<div className="core" />}>
              <Core onChanged={refreshPending} />
            </Suspense>
          )}
          {current === 'day' && <Day onChanged={refreshPending} />}
          {current === 'tasks' && <Tasks />}
          {current === 'finance' && <Finance />}
          {current === 'settings' && <SettingsScreen onLogout={() => setAuth({ ...auth, ok: false })} />}
        </main>
      </div>
    </ToastHost>
  );
}
