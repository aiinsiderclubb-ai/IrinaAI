import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { IconLogo } from '../icons';

export function Login({ token, passwordLogin, onDone }: { token: string | null; passwordLogin: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(Boolean(token));
  const [password, setPassword] = useState('');
  const tried = useRef(false);

  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    api
      .post('/api/auth/magic', { token })
      .then(onDone)
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : 'Не вдалося увійти');
        setBusy(false);
        window.history.replaceState(null, '', '#/login');
      });
  }, [token, onDone]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password', { password });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не вдалося увійти');
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="card">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">
            <IconLogo size={18} />
          </span>
          Асистент
        </div>
        {busy && token ? (
          <p className="muted">Вхід…</p>
        ) : (
          <>
            <h1 style={{ fontSize: 22 }}>Вхід у кабінет</h1>
            <ol>
              <li>Відкрийте свого асистента в Telegram.</li>
              <li>
                Надішліть команду <b>/web</b>.
              </li>
              <li>Перейдіть за одноразовим посиланням (діє 10 хвилин).</li>
            </ol>
            {passwordLogin && (
              <form onSubmit={submit} className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input" style={{ flex: 1 }} type="password" placeholder="або пароль" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                <button className="btn btn-primary" disabled={busy || !password}>
                  Увійти
                </button>
              </form>
            )}
          </>
        )}
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
