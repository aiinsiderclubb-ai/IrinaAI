import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { todayIso } from '../format';
import { IconPlus } from '../icons';
import type { Task } from '../types';
import { ErrorNote, Loading, useLoad, useToast } from '../ui';
import { TaskRow, useCompleteTask } from './Day';

export function Tasks() {
  const [project, setProject] = useState('');
  const [showDone, setShowDone] = useState(false);
  const { data, error, loading, reload } = useLoad<{ tasks: Task[]; projects: string[] }>(
    `/api/tasks?project=${encodeURIComponent(project)}&done=${showDone ? 1 : 0}`,
  );
  const [draft, setDraft] = useState({ title: '', project: '', due: '' });
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const complete = useCompleteTask(() => void reload());
  const today = todayIso();

  const groups = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of data?.tasks ?? []) {
      const k = t.project || 'Без проєкту';
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    for (const list of m.values()) list.sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999').localeCompare(b.due ?? '9999'));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) return;
    if (!window.confirm(`Створити задачу «${draft.title.trim()}»?`)) return;
    setSaving(true);
    try {
      const r = await api.post<{ ok: boolean; text: string }>('/api/tasks', { title: draft.title, project: draft.project || undefined, due: draft.due || undefined });
      toast(r.text);
      setDraft({ title: '', project: draft.project, due: '' });
      void reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const projects = data?.projects ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Задачі</h1>
          <p>З вашого Notion. Зміни через асистента або тут.</p>
        </div>
        <div className="row">
          <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Проєкт">
            <option value="">Усі проєкти</option>
            {projects.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <label className="toggle">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> завершені
          </label>
        </div>
      </div>

      <form className="card card-pad row" onSubmit={add}>
        <input className="input" style={{ flex: '1 1 260px' }} placeholder="Нова задача…" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Назва задачі" />
        <select className="select" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} aria-label="Проєкт задачі">
          <option value="">Проєкт…</option>
          {projects.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <input className="input" type="date" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} aria-label="Дедлайн" />
        <button className="btn btn-primary" disabled={saving || !draft.title.trim()}>
          <IconPlus size={18} /> Додати
        </button>
      </form>

      {loading && !data && <Loading />}
      <ErrorNote text={error} />
      {data && groups.length === 0 && <div className="card empty">Задач немає.</div>}
      {groups.map(([name, list]) => (
        <section className="card" key={name}>
          <div className="card-head">
            <h2>{name}</h2>
            <span className="count">{list.length}</span>
          </div>
          <ul className="list">
            {list.map((t) => (
              <TaskRow key={t.id} t={t} today={today} onDone={complete} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
