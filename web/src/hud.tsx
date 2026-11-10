/* HUD building blocks shared by every screen: the 24-hour day dial, progress rings,
   counting numbers, the live clock and the ambient particle field behind the pages. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CalEvent } from './types';
import { onThemeChange } from './theme';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- time ----------
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
/** date (YYYY-MM-DD) and minutes since midnight of a moment, in the owner's time zone */
export function tzParts(at: Date | string, timeZone?: string): { date: string; min: number } {
  const key = timeZone ?? '';
  let f = partsFmt.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    partsFmt.set(key, f);
  }
  const s = f.format(typeof at === 'string' ? new Date(at) : at); // "2026-11-10 15:09"
  const [date, hm] = s.split(' ');
  const [h, m] = (hm ?? '0:0').split(':').map(Number);
  return { date: date!, min: h! * 60 + m! };
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const durationText = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} год${m ? ` ${m} хв` : ''}` : `${m} хв`;
};

// ---------- counting number ----------
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString('uk-UA'), ms = 900 }: { value: number; format?: (n: number) => string; ms?: number }) {
  const [shown, setShown] = useState(() => (reduced() ? value : 0));
  const from = useRef(0);
  useEffect(() => {
    if (reduced()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const v = a + (value - a) * e;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

// ---------- ring ----------
export function Ring({ value, size = 64, stroke = 4, tone = 'accent', children }: { value: number; size?: number; stroke?: number; tone?: 'accent' | 'warn' | 'danger' | 'ok' | 'violet'; children?: ReactNode }) {
  const r = (size - stroke) / 2 - 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={`ring ring-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle className="ring-tick" cx={size / 2} cy={size / 2} r={r + stroke / 2 + 2.5} strokeWidth={1} strokeDasharray="1 5" />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children !== undefined && <div className="ring-label">{children}</div>}
    </div>
  );
}

// ---------- 24-hour day dial ----------
const polar = (cx: number, cy: number, r: number, min: number) => {
  const a = (min / 1440) * Math.PI * 2 - Math.PI / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};
const arc = (cx: number, cy: number, r: number, m0: number, m1: number) => {
  const [x0, y0] = polar(cx, cy, r, m0);
  const [x1, y1] = polar(cx, cy, r, m1);
  const large = m1 - m0 > 720 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export interface DialProps {
  events: CalEvent[];
  date: string;
  timeZone?: string;
  workday?: { start: string; end: string };
  size?: number;
  compact?: boolean;
}

/** The day as a radar: 24 hours around the circle, events as arcs, a sweeping "now" hand. */
export function DayDial({ events, date, timeZone, workday, size = 260, compact = false }: DialProps) {
  const now = useNow(compact ? 15_000 : 1000);
  const C = 130;
  const nowP = tzParts(now, timeZone);
  const nowMin = nowP.date === date ? nowP.min : nowP.date > date ? 1440 : 0;

  const spans = events
    .filter((e) => !e.allDay)
    .map((e) => {
      const s = tzParts(e.start, timeZone);
      const f = tzParts(e.end, timeZone);
      const m0 = s.date < date ? 0 : s.date > date ? 1440 : s.min;
      const m1 = f.date > date ? 1440 : f.date < date ? 0 : f.min;
      return { e, m0, m1: Math.max(m1, m0 + 8) };
    })
    .filter((x) => x.m1 > 0 && x.m0 < 1440);

  const next = spans.filter((x) => x.m0 > nowMin).sort((a, b) => a.m0 - b.m0)[0];
  const current = spans.find((x) => x.m0 <= nowMin && x.m1 > nowMin);
  const wd = workday ? { s: hm(workday.start), e: hm(workday.end) } : null;
  const [hx, hy] = polar(C, C, 121, nowMin);
  const [ix, iy] = polar(C, C, 58, nowMin);
  const [dx, dy] = polar(C, C, 96, nowMin);

  const ticks = [];
  for (let i = 0; i < 96; i++) {
    const major = i % 4 === 0;
    const six = i % 24 === 0;
    const [x0, y0] = polar(C, C, six ? 112 : major ? 115 : 118, i * 15);
    const [x1, y1] = polar(C, C, 122, i * 15);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={six ? 'dial-tick six' : major ? 'dial-tick major' : 'dial-tick'} />);
  }
  const labels = [0, 6, 12, 18].map((h) => {
    const [x, y] = polar(C, C, 103, h * 60);
    return (
      <text key={h} x={x} y={y} className="dial-label" textAnchor="middle" dominantBaseline="central">
        {String(h).padStart(2, '0')}
      </text>
    );
  });

  const hhmm = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone });
  const sec = now.toLocaleTimeString('uk-UA', { second: '2-digit', timeZone }).padStart(2, '0');
  const caption = current
    ? `зараз · ще ${durationText(current.m1 - nowMin)}`
    : next
      ? `далі через ${durationText(next.m0 - nowMin)}`
      : wd && nowMin < wd.e
        ? `до кінця дня ${durationText(wd.e - nowMin)}`
        : 'день вільний';

  return (
    <div className={`dial ${compact ? 'dial-compact' : ''}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 260 260" width={size} height={size} role="img" aria-label={`Розклад дня, зараз ${hhmm}`}>
        <defs>
          <radialGradient id="dial-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: 'rgb(var(--accent-rgb) / 0.16)' }} />
            <stop offset="70%" style={{ stopColor: 'rgb(var(--accent-rgb) / 0.03)' }} />
            <stop offset="100%" style={{ stopColor: 'transparent' }} />
          </radialGradient>
        </defs>
        <circle cx={C} cy={C} r={126} className="dial-outer" />
        <g className="dial-spin">
          <circle cx={C} cy={C} r={128} className="dial-orbit" />
        </g>
        <g className="dial-spin-rev">
          <circle cx={C} cy={C} r={66} className="dial-orbit inner" />
        </g>
        <circle cx={C} cy={C} r={86} fill="url(#dial-core)" />
        {ticks}
        {labels}
        <circle cx={C} cy={C} r={96} className="dial-track" />
        {wd && wd.e > wd.s && <path d={arc(C, C, 80, wd.s, wd.e)} className="dial-work" />}
        {/* time already lived today */}
        {nowMin > 0 && <path d={arc(C, C, 96, 0, Math.min(nowMin, 1439.9))} className="dial-elapsed" />}
        {spans.map(({ e, m0, m1 }) => (
          <path key={e.id} d={arc(C, C, 96, m0, Math.min(m1, 1439.9))} className={`dial-event ${e.title.startsWith('🎯') ? 'focus' : e.account} ${m1 <= nowMin ? 'past' : ''} ${m0 <= nowMin && m1 > nowMin ? 'now' : ''}`}>
            <title>{e.title}</title>
          </path>
        ))}
        {nowP.date === date && (
          <g className="dial-hand">
            <line x1={ix} y1={iy} x2={hx} y2={hy} />
            <circle cx={dx} cy={dy} r={4.5} />
          </g>
        )}
      </svg>
      <div className="dial-center">
        <div className="dial-time">
          {hhmm}
          {!compact && <span className="dial-sec">{sec}</span>}
        </div>
        <div className="dial-cap">{caption}</div>
      </div>
    </div>
  );
}

// ---------- ambient particle field behind the pages ----------
export function AmbientField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let rgb = '85 230 255';
    const readColor = () => {
      rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || rgb;
    };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const count = Math.round(Math.min(90, (window.innerWidth * window.innerHeight) / 18000));
    const pts = Array.from({ length: count }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12,
      r: Math.random() * 1.4 + 0.3,
      p: Math.random() * Math.PI * 2,
    }));
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const a of pts) {
        a.x = (a.x + a.vx + w) % w;
        a.y = (a.y + a.vy + h) % h;
      }
      ctx.lineWidth = 0.6;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j]!;
          const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
          if (d2 < 120 * 120) {
            ctx.strokeStyle = `rgb(${rgb} / ${(0.09 * (1 - Math.sqrt(d2) / 120)).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      for (const a of pts) {
        const tw = 0.35 + 0.35 * Math.sin(t / 900 + a.p);
        ctx.fillStyle = `rgb(${rgb} / ${tw.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || t - last < 33) return; // ~30 fps is plenty for a drifting field
      last = t;
      draw(t);
    };
    readColor();
    resize();
    if (reduced()) draw(0);
    else raf = requestAnimationFrame(loop);
    const off = onThemeChange(() => {
      readColor();
      if (reduced()) draw(0);
    });
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      off();
      window.removeEventListener('resize', resize);
    };
  }, []);
  return <canvas ref={ref} className="ambient" aria-hidden="true" />;
}

// ---------- top status strip ----------
export function HudBar({ name, section, pending, timeZone }: { name: string; section: string; pending: number; timeZone?: string }) {
  const now = useNow(1000);
  const time = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone });
  const date = now.toLocaleDateString('uk-UA', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone });
  return (
    <header className="hudbar">
      <div className="hudbar-id">
        <i className="live-dot" />
        <span className="hudbar-name">{name}</span>
        <span className="hudbar-sep">/</span>
        <span className="hudbar-section">{section}</span>
      </div>
      <div className="hudbar-line" aria-hidden="true" />
      <div className="hudbar-right">
        {pending > 0 && (
          <a className="hudbar-chip warn" href="#/day">
            {pending} чекає підтвердження
          </a>
        )}
        <span className="hudbar-chip">online</span>
        <span className="hudbar-clock">
          <span className="hudbar-date">{date}</span> {time}
        </span>
      </div>
    </header>
  );
}

/** card header: index tick, title, right-side slot */
export function PanelHead({ title, right, code }: { title: string; right?: ReactNode; code?: string }) {
  return (
    <div className="card-head">
      <h2>
        {title}
        {code && <span className="panel-code">{code}</span>}
      </h2>
      {right}
    </div>
  );
}
