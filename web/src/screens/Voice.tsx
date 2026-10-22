import { useEffect, useRef, useState } from 'react';
import { IconMic } from '../icons';
import type { Proposal, Settings } from '../types';
import { ProposalCard, useLoad, useToast } from '../ui';
import { StandardVoice } from '../voice/pipeline';
import { RealtimeVoice } from '../voice/realtime';
import { RealtimeUnavailable, type VoiceEngine, type VoiceHandlers, type VoiceStatus } from '../voice/types';

const NO_REALTIME_KEY = 'aia.realtimeUnavailableUntil';
const realtimeBlocked = () => Number(localStorage.getItem(NO_REALTIME_KEY) ?? 0) > Date.now();

const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: 'Натисни, щоб поговорити',
  connecting: 'Підключаюсь…',
  listening: 'Слухаю',
  hearing: 'Чую тебе…',
  thinking: 'Думаю…',
  speaking: 'Говорю',
  error: 'Помилка',
};

interface Line {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/** Feeds mic + voice loudness into a CSS variable so the orb "breathes" with the conversation. */
function useLevel(engine: VoiceEngine | null, active: boolean, el: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!engine || !active) return;
    let raf = 0;
    const tick = () => {
      el.current?.style.setProperty('--level', engine.level().toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      el.current?.style.setProperty('--level', '0');
    };
  }, [engine, active, el]);
}

export function Voice({ onChanged }: { onChanged: () => void }) {
  const settings = useLoad<Settings>('/api/settings');
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [cards, setCards] = useState<Proposal[]>([]);
  const [handsFree, setHandsFree] = useState(() => localStorage.getItem('aia.handsFree') === '1');
  const [muted, setMuted] = useState(false);
  const [voice, setVoice] = useState<VoiceEngine | null>(null);
  const orb = useRef<HTMLButtonElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const name = settings.data?.assistantName ?? 'Асистент';
  const active = status !== 'idle' && status !== 'error';

  useLevel(voice, active, orb);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [lines, cards]);

  // proactive nudges arrive app-wide; while a session is open the assistant says them out loud
  useEffect(() => {
    const on = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (voice?.active) voice.announce(text);
    };
    window.addEventListener('aia:nudge', on);
    return () => window.removeEventListener('aia:nudge', on);
  }, [voice]);

  useEffect(() => () => voice?.stop(), [voice]);

  const start = async () => {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
    const handlers: VoiceHandlers = {
      onStatus: setStatus,
      onLine: (role, text) => setLines((l) => [...l.slice(-40), { role, text }]),
      onProposals: (p) => {
        setCards((c) => [...c, ...p]);
        onChanged();
      },
      onError: (msg) => toast(msg),
    };
    const run = async (engine: VoiceEngine) => {
      setVoice(engine);
      setMuted(false);
      await engine.start();
    };
    try {
      if (realtimeBlocked()) await run(new StandardVoice(handlers, handsFree));
      else {
        try {
          await run(new RealtimeVoice(handlers, handsFree));
        } catch (e) {
          if (!(e instanceof RealtimeUnavailable)) throw e;
          localStorage.setItem(NO_REALTIME_KEY, String(Date.now() + 24 * 3600_000));
          toast('Миттєвий голосовий режим недоступний для цього ключа OpenAI — працюю у стандартному');
          await run(new StandardVoice(handlers, handsFree));
        }
      }
    } catch (e) {
      setStatus('error');
      toast(e instanceof Error ? (e.name === 'NotAllowedError' ? 'Дозволь доступ до мікрофона' : e.message) : String(e));
    }
  };

  const stop = () => {
    voice?.stop();
    setVoice(null);
  };

  const toggleHandsFree = (on: boolean) => {
    setHandsFree(on);
    localStorage.setItem('aia.handsFree', on ? '1' : '0');
    if (active) toast('Режим зміниться з наступної розмови');
  };

  return (
    <div className="voice">
      <div className="voice-stage">
        <button className={`orb orb-${status}`} ref={orb} onClick={active ? stop : start} aria-label={active ? 'Завершити розмову' : 'Почати розмову'}>
          <span className="orb-core">
            <IconMic size={30} />
          </span>
        </button>
        <div className="voice-name">{name}</div>
        {voice && active && <span className="pill">{voice.kind === 'realtime' ? 'миттєвий режим' : 'стандартний режим'}</span>}
        <div className="voice-status" aria-live="polite">
          {status === 'listening' && handsFree ? `На зв’язку — поклич «${name}»` : STATUS_TEXT[status]}
        </div>
        <div className="row" style={{ justifyContent: 'center' }}>
          {active ? (
            <>
              <button
                className="btn"
                onClick={() => {
                  voice?.setMuted(!muted);
                  setMuted(!muted);
                }}
              >
                {muted ? 'Увімкнути мікрофон' : 'Вимкнути мікрофон'}
              </button>
              <button className="btn" onClick={stop}>
                Завершити
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={start}>
              Почати розмову
            </button>
          )}
        </div>
        <label className="toggle" style={{ justifyContent: 'center' }}>
          <input type="checkbox" checked={handsFree} onChange={(e) => toggleHandsFree(e.target.checked)} />
          На зв’язку: слухаю постійно, відповідаю, коли кличуть «{name}»
        </label>
      </div>

      <div className="voice-log">
        {lines.length === 0 && cards.length === 0 && (
          <p className="muted" style={{ textAlign: 'center' }}>
            Говори як із людиною: «що в мене далі?», «перенеси лист юристу на завтра», «запам’ятай, що Олена — наш юрист». Зміни виконуються після твого «так».
          </p>
        )}
        {lines.map((l, i) =>
          l.role === 'system' ? (
            <div key={i} className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
              {l.text}
            </div>
          ) : (
            <div key={i} className={`bubble ${l.role}`}>
              {l.text}
            </div>
          ),
        )}
        {cards.map((p) => (
          <ProposalCard key={p.id} p={p} projects={settings.data?.projects} onResolved={onChanged} />
        ))}
        <div ref={logEnd} />
      </div>
    </div>
  );
}
