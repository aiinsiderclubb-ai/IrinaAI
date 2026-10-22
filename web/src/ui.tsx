import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { Proposal } from './types';

// ---------- toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={setMsg}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ---------- data loading ----------
export function useLoad<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await api.get<T>(url));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export const Loading = ({ text = 'Завантаження…' }: { text?: string }) => (
  <div className="loading">
    <div className="spin" /> {text}
  </div>
);

export const ErrorNote = ({ text }: { text?: string | null }) => (text ? <div className="note-error">{text}</div> : null);

// ---------- confirmation card (contract 2.5: nothing changes until the owner confirms) ----------
const KIND_LABEL: Record<string, string> = {
  'task.create': 'Нова задача',
  'task.update': 'Зміна задачі',
  'task.complete': 'Завершення задачі',
  'task.reschedule': 'Перенесення',
  'decision.log': 'Рішення',
  'waiting.add': 'Очікую відповідь',
  'waiting.resolve': 'Відповідь отримано',
  'calendar.create': 'Подія в календарі',
  'plan.apply': 'План дня',
  'finance.record': 'Фінанси',
  'note.save': 'Матеріал',
};

type CardState = { status: 'pending' | 'busy' | 'done' | 'failed' | 'cancelled'; result?: string };

export function ProposalCard({ p, projects = [], onResolved }: { p: Proposal; projects?: string[]; onResolved?: () => void }) {
  const [state, setState] = useState<CardState>({ status: 'pending' });
  const [proposal, setProposal] = useState(p);
  const needsProject = proposal.kind === 'note.save' && !proposal.project && projects.length > 0;

  const confirm = async () => {
    setState({ status: 'busy' });
    try {
      const r = await api.post<{ ok: boolean; text: string }>(`/api/pending/${proposal.id}/confirm`);
      setState({ status: r.ok ? 'done' : 'failed', result: r.text });
    } catch (e) {
      setState({ status: 'failed', result: e instanceof ApiError ? e.message : String(e) });
    }
    onResolved?.();
  };
  const cancel = async () => {
    setState({ status: 'busy' });
    await api.post(`/api/pending/${proposal.id}/cancel`).catch(() => {});
    setState({ status: 'cancelled', result: 'Скасовано' });
    onResolved?.();
  };
  const setProject = async (project: string) => {
    const r = await api.post<{ proposal: Proposal }>(`/api/pending/${proposal.id}/project`, { project });
    setProposal(r.proposal);
  };

  const cls = state.status === 'done' ? 'done' : state.status === 'failed' ? 'failed' : state.status === 'cancelled' ? 'cancelled' : '';
  return (
    <div className={`proposal ${cls}`}>
      <div className="label">{KIND_LABEL[proposal.kind] ?? proposal.kind}</div>
      <div className="summary">{state.result ?? proposal.summary}</div>
      {(state.status === 'pending' || state.status === 'busy') && (
        <div className="row">
          {needsProject ? (
            <select className="select" defaultValue="" onChange={(e) => e.target.value && void setProject(e.target.value)} aria-label="Проєкт">
              <option value="" disabled>
                Оберіть проєкт…
              </option>
              {projects.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={confirm} disabled={state.status === 'busy'}>
              {state.status === 'busy' ? 'Виконую…' : 'Підтвердити'}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={state.status === 'busy'}>
            Скасувати
          </button>
        </div>
      )}
    </div>
  );
}

export function ReportModal({ kind, onClose }: { kind: 'morning' | 'evening'; onClose: () => void }) {
  const { data, error, loading } = useLoad<{ html: string }>(`/api/reports/${kind}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal card-pad" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2>{kind === 'morning' ? 'Ранковий звіт' : 'Вечірній звіт'}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Закрити
          </button>
        </div>
        {loading && <Loading text="Збираю звіт…" />}
        {error && <ErrorNote text={error} />}
        {/* server-generated HTML: every value is escaped server-side, only <b>/<i> tags remain */}
        {data && <div className="report" dangerouslySetInnerHTML={{ __html: data.html }} />}
      </div>
    </div>
  );
}
