import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { Memory, Settings } from '../types';
import { ErrorNote, Loading, useLoad, useToast } from '../ui';
import { Connections } from './Connections';
import { useTheme, type ThemeChoice } from '../theme';

const WEEKDAYS = ['понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота', 'неділя'];

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const settings = useLoad<Settings>('/api/settings');
  const memories = useLoad<{ items: Memory[] }>('/api/memories');
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const { assistantName, ownerName, ownerGender, ttsVoice, ttsStyle, elevenVoice, morningTime, eveningTime, workdayStart, workdayEnd, voiceReplies, planCalendar, mirrorDetails, eventsGeo, eventsWeekday, eventsTime } = form;
      const eventsTopics = form.eventsTopics.map((t) => t.trim()).filter(Boolean);
      const next = await api.patch<Settings>('/api/settings', { assistantName: assistantName.trim(), ownerName: ownerName.trim(), ownerGender, ttsVoice, ttsStyle, elevenVoice, morningTime, eveningTime, workdayStart, workdayEnd, voiceReplies, planCalendar, mirrorDetails, eventsGeo, eventsWeekday, eventsTime, eventsTopics });
      settings.setData(next);
      toast('Збережено');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    onLogout();
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const topics = [...(form?.eventsTopics ?? []), '', '', ''].slice(0, 3);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Налаштування</h1>
          <p>Те саме можна змінити фразою в чаті, наприклад «ранковий звіт о 7:30».</p>
        </div>
        <button className="btn" onClick={logout}>
          Вийти
        </button>
      </div>

      <Appearance />

      <Connections />

      {!form ? (
        <Loading />
      ) : (
        <form className="stack" onSubmit={save}>
          <section className="card">
            <div className="card-head">
              <h2>Характер асистента</h2>
            </div>
            <div className="form-grid">
              <label className="field">
                Ім’я асистента (ним і кличуть у режимі «на зв’язку»)
                <input className="input" value={form.assistantName} maxLength={40} onChange={(e) => set('assistantName', e.target.value)} required />
              </label>
              <label className="field">
                Як він звертається до тебе
                <input className="input" value={form.ownerName} maxLength={40} placeholder="напр. Ірино" onChange={(e) => set('ownerName', e.target.value)} />
              </label>
              <label className="field">
                Рід звертання
                <select className="select" value={form.ownerGender} onChange={(e) => set('ownerGender', e.target.value as Settings['ownerGender'])}>
                  <option value="female">жіночий («ти заслужила»)</option>
                  <option value="male">чоловічий («ти заслужив»)</option>
                  <option value="">нейтрально</option>
                </select>
              </label>
            </div>
          </section>

          <VoicePicker form={form} set={set} />

          <section className="card">
            <div className="card-head">
              <h2>Звіти та робочий день</h2>
              <span className="count">{form.timezone}</span>
            </div>
            <div className="form-grid">
              <label className="field">
                Ранковий звіт
                <input className="input" type="time" value={form.morningTime} onChange={(e) => set('morningTime', e.target.value)} required />
              </label>
              <label className="field">
                Вечірній звіт
                <input className="input" type="time" value={form.eveningTime} onChange={(e) => set('eveningTime', e.target.value)} required />
              </label>
              <label className="field">
                Початок робочого дня
                <input className="input" type="time" value={form.workdayStart} onChange={(e) => set('workdayStart', e.target.value)} required />
              </label>
              <label className="field">
                Кінець робочого дня
                <input className="input" type="time" value={form.workdayEnd} onChange={(e) => set('workdayEnd', e.target.value)} required />
              </label>
              <label className="field">
                Голосові відповіді
                <select className="select" value={form.voiceReplies} onChange={(e) => set('voiceReplies', e.target.value as Settings['voiceReplies'])}>
                  <option value="mirror">голосом на голосове</option>
                  <option value="always">завжди голосом</option>
                  <option value="never">лише текст</option>
                </select>
              </label>
              <label className="field">
                План дня ставити в календар
                <select className="select" value={form.planCalendar} onChange={(e) => set('planCalendar', e.target.value as Settings['planCalendar'])}>
                  <option value="work">робочий</option>
                  <option value="personal">особистий</option>
                </select>
              </label>
            </div>
            <div style={{ padding: '0 20px 18px' }}>
              <label className="toggle">
                <input type="checkbox" checked={form.mirrorDetails} onChange={(e) => set('mirrorDetails', e.target.checked)} />
                Показувати назви подій при синхронізації календарів (інакше — «Зайнято»)
              </label>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Пошук подій і конференцій</h2>
            </div>
            <div className="form-grid">
              {topics.map((t, i) => (
                <label className="field" key={i}>
                  Тема {i + 1}
                  <input
                    className="input"
                    value={t}
                    placeholder={i === 0 ? 'напр. AI у бізнесі' : ''}
                    onChange={(e) => {
                      const next = [...topics];
                      next[i] = e.target.value;
                      set('eventsTopics', next);
                    }}
                  />
                </label>
              ))}
              <label className="field">
                Географія
                <input className="input" value={form.eventsGeo} placeholder="напр. Європа, онлайн" onChange={(e) => set('eventsGeo', e.target.value)} />
              </label>
              <label className="field">
                День підбірки
                <select className="select" value={form.eventsWeekday} onChange={(e) => set('eventsWeekday', Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i + 1}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Час підбірки
                <input className="input" type="time" value={form.eventsTime} onChange={(e) => set('eventsTime', e.target.value)} required />
              </label>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Пам’ять</h2>
              <span className="count">{memories.data?.items.length ?? 0}</span>
            </div>
            {memories.data?.items.length ? (
              <ul className="list">
                {memories.data.items.map((m) => (
                  <li key={m.id}>
                    <div className="grow">
                      <div className="title">{m.subject}</div>
                      <div className="meta">{m.content}</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        if (!window.confirm(`Забути «${m.subject}»?`)) return;
                        await api.del(`/api/memories/${m.id}`);
                        void memories.reload();
                      }}
                    >
                      Забути
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty">Поки нічого. Скажи асистенту, наприклад: «запам’ятай, що Олена — наш юрист».</div>
            )}
          </section>

          <section className="card card-pad">
            <h2 style={{ marginBottom: 8 }}>Довідники</h2>
            <p className="muted" style={{ margin: 0 }}>
              Проєкти: {form.projects.join(', ') || '—'}
              <br />
              Категорії витрат: {form.categories.expense.join(', ') || '—'} · доходів: {form.categories.income.join(', ') || '—'} · валюта {form.currency}
            </p>
          </section>

          {error && <div className="note-error" style={{ margin: 0 }}>{error}</div>}
          <div className="row">
            <button className="btn btn-primary" disabled={saving}>
              {saving ? 'Зберігаю…' : 'Зберегти'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

interface VoiceOptions {
  provider: 'openai' | 'elevenlabs' | 'other' | 'none';
  voices: Array<{ id: string; label: string }>;
  styles: Array<{ id: string; label: string }>;
}

function VoicePicker({ form, set }: { form: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void }) {
  const opts = useLoad<VoiceOptions>('/api/voice/options');
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const toast = useToast();

  const preview = async () => {
    audio.current?.pause();
    setPlaying(true);
    try {
      const r = await api.post<{ audio: string }>('/api/voice/preview', { voice: eleven ? form.elevenVoice : form.ttsVoice, style: form.ttsStyle });
      const a = new Audio(`data:audio/mpeg;base64,${r.audio}`);
      audio.current = a;
      a.onended = () => setPlaying(false);
      await a.play();
    } catch (e) {
      setPlaying(false);
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const o = opts.data;
  const eleven = o?.provider === 'elevenlabs';
  return (
    <section className="card">
      <div className="card-head">
        <h2>Голос</h2>
        <span className="count">{o?.provider === 'elevenlabs' ? 'ElevenLabs' : o?.provider === 'openai' ? 'OpenAI' : ''}</span>
      </div>
      {
        <div className="form-grid">
          <label className="field">
            Голос
            <select className="select" value={eleven ? form.elevenVoice : form.ttsVoice} onChange={(e) => set(eleven ? 'elevenVoice' : 'ttsVoice', e.target.value)}>
              {o?.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Манера
            <select className="select" value={form.ttsStyle} onChange={(e) => set('ttsStyle', e.target.value)}>
              {o?.styles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={preview} disabled={playing || o?.provider === 'none'}>
              {playing ? 'Звучить…' : '▶ Прослухати'}
            </button>
          </div>
        </div>
      }
      <div className="empty" style={{ paddingTop: 0 }}>
        {eleven
          ? 'ElevenLabs, носії української. Живу розмову озвучує швидка модель, голосові в Telegram і брифінги — якісна; голос той самий.'
          : 'Голос використовується в Telegram, ядрі та брифінгах. Найбільш людяний варіант — ElevenLabs (потрібен ключ).'}
      </div>
    </section>
  );
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'auto', label: 'Як у системі' },
  { id: 'light', label: 'Світла' },
  { id: 'dark', label: 'Темна' },
];

function Appearance() {
  const { choice, set } = useTheme();
  return (
    <section className="card card-pad appearance">
      <div>
        <h2>Оформлення</h2>
        <p className="muted">Запам’ятовується на цьому пристрої.</p>
      </div>
      <div className="seg" role="radiogroup" aria-label="Тема">
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={choice === t.id} className={choice === t.id ? 'on' : ''} onClick={() => set(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
    </section>
  );
}
