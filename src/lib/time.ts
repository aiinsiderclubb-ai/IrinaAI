import { DateTime } from 'luxon';

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function nowIn(clock: Clock, zone: string): DateTime {
  return DateTime.fromJSDate(clock(), { zone });
}

/** Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss]` (wall time in `zone`) or a full ISO string with offset. */
export function parseLocal(input: string, zone: string): DateTime {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(input);
  const dt = hasOffset ? DateTime.fromISO(input, { setZone: false }).setZone(zone) : DateTime.fromISO(input, { zone });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${input}`);
  return dt;
}

export function dayBounds(day: DateTime): { start: DateTime; end: DateTime } {
  return { start: day.startOf('day'), end: day.plus({ days: 1 }).startOf('day') };
}

/** `HH:mm` on the given day in its own zone. */
export function atTime(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  return day.startOf('day').set({ hour: h ?? 0, minute: m ?? 0 });
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function fmtTime(dt: DateTime): string {
  return dt.toFormat('HH:mm');
}

export function fmtDate(dt: DateTime): string {
  return dt.setLocale('uk').toFormat('ccc, d LLL');
}
