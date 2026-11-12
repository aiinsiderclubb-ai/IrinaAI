import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { IconPlus } from '../icons';
import { ErrorNote, Loading, useLoad, useToast } from '../ui';

interface ProjectView {
  id: number;
  name: string;
  active: boolean;
  notionUrl: string | null;
  summary: string;
  syncedAt: string | null;
  syncing: boolean;
  syncError: string | null;
  counts: Record<string, number>;
}

interface MaterialView {
  id: number;
  kind: string;
  title: string;
  source: string | null;
  chars: number;
  updatedAt: string;
}

const KIND: Record<string, string> = {
  notion: 'Сторінка Notion',
  notion_db: 'Таблиця Notion',
  file: 'Файл',
  link: 'Сайт',
  chat: 'З чату',
  note: 'Нотатка',
  report: 'Звіт',
};

const countLine = (c: Record<string, number>) =>
  [
    c.notion ? `${c.notion} стор.` : '',
    c.notion_db ? `${c.notion_db} табл.` : '',
    c.file ? `${c.file} файлів` : '',
    c.link ? `${c.link} сайтів` : '',
    (c.chat ?? 0) + (c.note ?? 0) + (c.report ?? 0) ? `${(c.chat ?? 0) + (c.note ?? 0) + (c.report ?? 0)} нотаток і звітів` : '',
  ]
    .filter(Boolean)
    .join(' · ') || 'матеріалів ще немає';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function Projects() {
  const { data, error, loading, reload } = useLoad<{ projects: ProjectView[] }>('/api/projects');
  const [draft, setDraft] = useState({ name: '', link: '' });
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const toast = useToast();
  const projects = data?.projects ?? [];
  const selected = projects.find((p) => p.id === openId) ?? projects.find((p) => p.active) ?? projects[0];
  const mats = useLoad<{ materials: MaterialView[] }>(selected ? `/api/projects/${selected.id}/materials` : null, [selected?.id, selected?.syncedAt]);

  // while a project is being read, refresh every few seconds
  const busy = projects.some((p) => p.syncing);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [busy, reload]);

  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      void reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim() && !draft.link.trim()) return;
    setSaving(true);
    try {
      const r = await api.post<{ ok: boolean; project: string; note: string }>('/api/projects', { name: draft.name, notionLink: draft.link });
      toast(`«${r.project}»: ${r.note}`);
      setDraft({ name: '', link: '' });
      setOpenId(null);
      void reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Робочі папки · {projects.length}</div>
          <h1>Проєкти</h1>
          <p>Дайте посилання на сторінку проєкту в Notion — асистент прочитає її з усіма підсторінками, файлами й посиланнями і далі працюватиме в цьому контексті.</p>
        </div>
      </div>

      <form className="card card-pad row" onSubmit={add}>
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Назва (необов’язково)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Назва проєкту" />
        <input
          className="input"
          style={{ flex: '2 1 320px' }}
          placeholder="Посилання на сторінку в Notion"
          value={draft.link}
          onChange={(e) => setDraft({ ...draft, link: e.target.value })}
          aria-label="Посилання на сторінку проєкту в Notion"
        />
        <button className="btn btn-primary" disabled={saving || (!draft.name.trim() && !draft.link.trim())}>
          <IconPlus size={18} /> Новий проєкт
        </button>
      </form>
      <p className="muted" style={{ margin: '-4px 4px 0', fontSize: 13 }}>
        Якщо асистент не бачить сторінку: у Notion відкрийте її → «•••» → Connections → додайте інтеграцію асистента. Вкладені сторінки отримають доступ самі.
      </p>

      {loading && !data && <Loading />}
      <ErrorNote text={error} />
      {data && !projects.length && <div className="card empty">Проєктів ще немає.</div>}

      {projects.length > 0 && (
        <div className="projects">
          <ul className="card list project-list" aria-label="Проєкти">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className={`project-item ${selected?.id === p.id ? 'is-open' : ''}`} onClick={() => setOpenId(p.id)} aria-pressed={selected?.id === p.id}>
                  <span className="project-name">
                    {p.name}
                    {p.active && <span className="pill">активний</span>}
                  </span>
                  <span className="muted">{p.syncing ? 'читаю сторінку…' : countLine(p.counts)}</span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <section className="card card-pad project-detail">
              <div className="card-head">
                <h2>{selected.name}</h2>
                <div className="row">
                  {!selected.active && (
                    <button type="button" className="btn" onClick={() => call(() => api.post(`/api/projects/${selected.id}/activate`), `Активний проєкт: «${selected.name}»`)}>
                      Зробити активним
                    </button>
                  )}
                  {selected.notionUrl && (
                    <button type="button" className="btn" disabled={selected.syncing} onClick={() => call(() => api.post(`/api/projects/${selected.id}/sync`), 'Перечитую сторінку…')}>
                      {selected.syncing ? 'Читаю…' : 'Перечитати'}
                    </button>
                  )}
                </div>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                {selected.notionUrl ? (
                  <a href={selected.notionUrl} target="_blank" rel="noreferrer">
                    Сторінка в Notion
                  </a>
                ) : (
                  'Без сторінки Notion — матеріали з чату'
                )}
                {selected.syncedAt && ` · прочитано ${when(selected.syncedAt)}`}
              </p>
              {selected.syncError && <div className="note-error">Не все вдалося прочитати: {selected.syncError}</div>}
              <h3 className="project-sub">Картка проєкту</h3>
              <div className="project-card">{selected.summary || (selected.syncing ? 'Готується…' : 'Ще порожньо.')}</div>
              <h3 className="project-sub">Матеріали</h3>
              {mats.loading && !mats.data && <Loading />}
              <ul className="list">
                {(mats.data?.materials ?? []).map((m) => (
                  <li key={m.id} className="material">
                    <span className="material-kind">{KIND[m.kind] ?? m.kind}</span>
                    <span className="material-title">
                      {m.source && /^https?:\/\//.test(m.source) ? (
                        <a href={m.source} target="_blank" rel="noreferrer">
                          {m.title}
                        </a>
                      ) : (
                        m.title
                      )}
                    </span>
                    <span className="muted">{m.chars.toLocaleString('uk-UA')} знаків</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
