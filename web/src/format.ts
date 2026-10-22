const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function time(iso: string, zone = tz()): string {
  return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: zone });
}

export function longDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  const s = d.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "сьогодні", "завтра", "прострочено 2 дн.", "пт, 24 жовт." */
export function dueLabel(due: string | undefined, today: string): { text: string; tone: 'late' | 'today' | 'soon' | 'later' } | undefined {
  if (!due) return undefined;
  const d = due.slice(0, 10);
  const diff = Math.round((new Date(`${d}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000);
  const withTime = due.length > 10 ? ` ${due.slice(11, 16)}` : '';
  if (diff < 0) return { text: `прострочено ${-diff} дн.`, tone: 'late' };
  if (diff === 0) return { text: `сьогодні${withTime}`, tone: 'today' };
  if (diff === 1) return { text: `завтра${withTime}`, tone: 'soon' };
  return { text: new Date(`${d}T12:00:00`).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' }), tone: diff <= 3 ? 'soon' : 'later' };
}

export function money(n: number, currency: string): string {
  try {
    return n.toLocaleString('uk-UA', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    return `${n.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} ${currency}`;
  }
}

export const num = (n: number) => n.toLocaleString('uk-UA', { maximumFractionDigits: 1 });

export const todayIso = () => new Date().toLocaleDateString('sv-SE');
