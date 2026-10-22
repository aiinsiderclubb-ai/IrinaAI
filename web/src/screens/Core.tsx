import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { CoreScene, webglAvailable } from '../core/CoreScene';
import { time } from '../format';
import { IconMic, IconSend } from '../icons';
import { go, useHash } from '../router';
import type { Proposal, Settings, Today } from '../types';
import { ProposalCard, useLoad, useToast } from '../ui';
import { LevelMeter } from '../voice/level';
import { StandardVoice } from '../voice/pipeline';
import { RealtimeVoice } from '../voice/realtime';
import { RealtimeUnavailable, type VoiceEngine, type VoiceHandlers, type VoiceStatus } from '../voice/types';

const NO_REALTIME_KEY = 'aia.realtimeUnavailableUntil';
const realtimeBlocked = () => Number(localStorage.getItem(NO_REALTIME_KEY) ?? 0) > Date.now();

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Очікую',
  connecting: 'Підключення',
  listening: 'Слухаю',
  hearing: 'Чую',
  thinking: 'Аналізую',
  speaking: 'Говорю',
  error: 'Збій',
};

interface Line {
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Plays a spoken reply outside a voice session (typed question) and measures it for the core. */
class ReplyPlayer {
  private audio = new Audio();
  private meter?: LevelMeter;
  onState?: (playing: boolean) => void;
  constructor() {
    this.audio.onplay = () => this.onState?.(true);
    this.audio.onended = () => this.onState?.(false);
    this.audio.onpause = () => this.onState?.(false);
  }
  play(b64: string) {
    if (!this.meter) {
      this.meter = new LevelMeter();
      this.meter.addElement(this.audio);
    }
    void this.meter.ctx.resume();
    this.audio.src = `data:audio/mpeg;base64,${b64}`;
    void this.audio.play().catch(() => this.onState?.(false));
  }
  stop() {
    this.audio.pause();
  }
  level() {
    return this.meter?.level() ?? 0;
  }
  dispose() {
    this.audio.pause();
    this.meter?.close();
  }
}

export function Core({ onChanged }: { onChanged: () => void }) {
  const settings = useLoad<Settings>('/api/settings');
  const today = useLoad<Today>('/api/today');
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [cards, setCards] = useState<Proposal[]>([]);
  const [handsFree, setHandsFree] = useState(() => localStorage.getItem('aia.handsFree') === '1');
  const [muted, setMuted] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<CoreScene | null>(null);
  const player = useRef<ReplyPlayer | null>(null);
  const engineRef = useRef<VoiceEngine | null>(null);
  const toast = useToast();
  const now = useClock();
  const name = settings.data?.assistantName ?? 'Асистент';
  const active = status !== 'idle' && status !== 'error';
  const [gl] = useState(webglAvailable);
  const { params } = useHash();
  const preview = params.get('state') as VoiceStatus | null;

  engineRef.current = engine;
  const previewRef = useRef(preview);
  previewRef.current = preview;

  // ---------- the core ----------
  useEffect(() => {
    if (!gl || !host.current) return;
    player.current = new ReplyPlayer();
    const s = new CoreScene(host.current, () => {
      if (engineRef.current?.active) return engineRef.current.level();
      // preview of the speaking/hearing look without audio: a synthetic voice envelope
      const p = previewRef.current;
      if (p === 'speaking' || p === 'hearing') {
        const t = performance.now() / 1000;
        return Math.max(0, 0.35 + 0.3 * Math.sin(t * 7.3) * Math.sin(t * 2.1) + 0.15 * Math.sin(t * 17));
      }
      return player.current?.level() ?? 0;
    });
    scene.current = s;
    return () => {
      s.dispose();
      player.current?.dispose();
      scene.current = null;
    };
  }, [gl]);

  useEffect(() => {
    scene.current?.setState(!engine && preview && preview in STATUS_LABEL ? preview : status);
  }, [status, preview, engine]);

  useEffect(() => {
    const t = setInterval(() => void today.reload(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => engineRef.current?.stop(), []);

  const push = useCallback((role: Line['role'], text: string) => setLines((l) => [...l.slice(-30), { role, text, at: Date.now() }]), []);

  // proactive nudges: spoken when a session is open, otherwise shown as the core's line
  useEffect(() => {
    const on = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (engineRef.current?.active) engineRef.current.announce(text);
      else push('assistant', `🔔 ${text}`);
    };
    window.addEventListener('aia:nudge', on);
    return () => window.removeEventListener('aia:nudge', on);
  }, [push]);

  // ---------- voice session ----------
  const start = async () => {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
    player.current?.stop();
    const handlers: VoiceHandlers = {
      onStatus: setStatus,
      onLine: push,
      onProposals: (p) => {
        setCards((c) => [...c, ...p]);
        onChanged();
      },
      onError: (msg) => toast(msg),
    };
    const run = async (e: VoiceEngine) => {
      setEngine(e);
      setMuted(false);
      await e.start();
    };
    try {
      if (realtimeBlocked()) await run(new StandardVoice(handlers, handsFree));
      else {
        try {
          await run(new RealtimeVoice(handlers, handsFree));
        } catch (e) {
          if (!(e instanceof RealtimeUnavailable)) throw e;
          localStorage.setItem(NO_REALTIME_KEY, String(Date.now() + 24 * 3600_000));
          await run(new StandardVoice(handlers, handsFree));
        }
      }
    } catch (e) {
      setEngine(null);
      setStatus('error');
      toast(e instanceof Error ? (e.name === 'NotAllowedError' ? 'Дозволь доступ до мікрофона' : e.message) : String(e));
      setTimeout(() => setStatus((s) => (s === 'error' ? 'idle' : s)), 2500);
    }
  };

  const stop = () => {
    engine?.stop();
    setEngine(null);
  };

  // ---------- typed question: the core still answers out loud ----------
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    push('user', text);
    setStatus('thinking');
    try {
      const r = await api.post<{ text: string; proposals: Proposal[] }>('/api/chat', { text });
      if (r.text) push('assistant', r.text);
      if (r.proposals.length) {
        setCards((c) => [...c, ...r.proposals]);
        onChanged();
      }
      if (r.text && !muted && settings.data?.voiceReplies !== 'never') {
        const spoken = await api.post<{ audio?: string }>('/api/voice/speak', { text: r.text }).catch(() => ({ audio: undefined }));
        if (spoken.audio && player.current) {
          player.current.onState = (playing) => setStatus(playing ? 'speaking' : engineRef.current?.active ? 'listening' : 'idle');
          player.current.play(spoken.audio);
          return;
        }
      }
      setStatus('idle');
    } catch (err) {
      push('system', err instanceof ApiError ? err.message : String(err));
      setStatus('idle');
    }
  };

  const toggleHandsFree = () => {
    const on = !handsFree;
    setHandsFree(on);
    localStorage.setItem('aia.handsFree', on ? '1' : '0');
    if (active) toast('Режим зміниться з наступної розмови');
  };

  // ---------- HUD data ----------
  const t = today.data;
  const nowMs = now.getTime();
  const next = t?.events.find((e) => !e.allDay && new Date(e.end).getTime() > nowMs);
  const lastUser = [...lines].reverse().find((l) => l.role === 'user');
  const lastAssistant = [...lines].reverse().find((l) => l.role !== 'user');
  const shown: VoiceStatus = !engine && preview && preview in STATUS_LABEL ? preview : status;
  const caption = shown === 'listening' && handsFree ? `Поклич «${name}»` : STATUS_LABEL[shown];
  const openCards = cards.slice(-3);

  return (
    <div className={`core core-${shown}`}>
      <div className="core-canvas" ref={host} />
      {!gl && <div className="core-fallback" aria-hidden="true" />}
      <div className="core-vignette" aria-hidden="true" />

      <header className="core-top">
        <button className="core-chip" onClick={() => go('today')}>
          ← Кабінет
        </button>
        <div className="core-title">
          <span className="core-name">{name}</span>
          <span className="core-state">
            <i className="core-dot" /> {caption}
            {engine && active && <em>{engine.kind === 'realtime' ? ' · миттєвий канал' : ' · стандартний канал'}</em>}
          </span>
        </div>
        <button className={`core-chip ${handsFree ? 'on' : ''}`} onClick={toggleHandsFree} title="Слухаю постійно, відповідаю, коли кличуть на ім’я">
          {handsFree ? '● На зв’язку' : '○ На зв’язку'}
        </button>
      </header>

      <aside className="core-hud core-hud-left">
        <div className="hud-time">{now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="hud-date">{now.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <div className="hud-block">
          <div className="hud-label">Далі</div>
          {next ? (
            <>
              <div className="hud-value">{next.title}</div>
              <div className="hud-sub">
                {time(next.start, t?.timezone)}–{time(next.end, t?.timezone)} · {next.account === 'work' ? 'робочий' : 'особистий'}
              </div>
            </>
          ) : (
            <div className="hud-sub">{t?.errors.calendar ? 'календар недоступний' : 'вільно до кінця дня'}</div>
          )}
        </div>
        {(t?.conflicts.length ?? 0) > 0 && (
          <div className="hud-block warn">
            <div className="hud-label">Накладки</div>
            <div className="hud-value">{t!.conflicts.length}</div>
          </div>
        )}
      </aside>

      <aside className="core-hud core-hud-right">
        <div className="hud-block">
          <div className="hud-label">Фокус · {t?.focus.length ?? 0}</div>
          {t?.focus.slice(0, 3).map((f) => (
            <div className="hud-task" key={f.id}>
              {f.title}
            </div>
          ))}
          {t && !t.focus.length && <div className="hud-sub">на сьогодні все закрито</div>}
        </div>
        <div className="hud-block">
          <div className="hud-label">Очікую · {t?.waiting.length ?? 0}</div>
          {t?.waiting.slice(0, 2).map((w) => (
            <div className="hud-task" key={w.id}>
              {w.title}
              {w.from ? <span> · {w.from}</span> : null}
            </div>
          ))}
        </div>
      </aside>

      <section className="core-cards">
        {openCards.map((p) => (
          <div className="core-card" key={p.id}>
            <ProposalCard p={p} projects={settings.data?.projects} onResolved={onChanged} />
          </div>
        ))}
      </section>

      <section className="core-subs" aria-live="polite">
        {lastUser && <p className="sub-user">{lastUser.text}</p>}
        {lastAssistant ? (
          <p className="sub-assistant" key={lastAssistant.at}>
            {lastAssistant.text}
          </p>
        ) : (
          <p className="sub-hint">{active ? 'Говори — я слухаю.' : 'Торкнись ядра, щоб поговорити, або напиши.'}</p>
        )}
      </section>

      <footer className="core-controls">
        {typing ? (
          <form className="core-input" onSubmit={ask}>
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Напиши ${name}…`} aria-label="Повідомлення" />
            <button className="core-round sm" aria-label="Надіслати" disabled={!draft.trim()}>
              <IconSend />
            </button>
            <button type="button" className="core-chip" onClick={() => setTyping(false)}>
              Голос
            </button>
          </form>
        ) : (
          <>
            <button className="core-chip" onClick={() => setTyping(true)}>
              Написати
            </button>
            <button className={`core-round ${active ? 'live' : ''}`} onClick={active ? stop : start} aria-label={active ? 'Завершити розмову' : 'Почати розмову'}>
              <IconMic size={26} />
            </button>
            <button
              className={`core-chip ${muted ? 'on' : ''}`}
              disabled={!active}
              onClick={() => {
                engine?.setMuted(!muted);
                setMuted(!muted);
              }}
            >
              {muted ? 'Мікрофон вимк.' : 'Тиша'}
            </button>
          </>
        )}
      </footer>

      {/* tap on the core itself starts/stops the conversation */}
      <button className="core-hit" onClick={active ? stop : start} aria-label={active ? 'Завершити розмову' : 'Почати розмову'} />
    </div>
  );
}
