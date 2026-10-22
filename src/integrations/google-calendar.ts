import type { GoogleAuth } from './google-auth.js';

export type Account = 'work' | 'personal';
export const ACCOUNTS: Account[] = ['work', 'personal'];
export const slotOf = (a: Account) => `google:${a}` as const;

export interface CalEvent {
  id: string;
  account: Account;
  title: string;
  /** ISO with offset; for all-day events `YYYY-MM-DD` */
  start: string;
  end: string;
  allDay: boolean;
  /** false for "free" (transparent) events */
  busy: boolean;
  /** copy created by the work<->personal mirror, never a source */
  mirror: boolean;
  cancelled: boolean;
  location?: string;
  description?: string;
  link?: string;
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  timeZone: string;
  description?: string;
  location?: string;
  mirror?: boolean;
}

/** What the rest of the system needs from a calendar backend. */
export interface CalendarPort {
  list(account: Account, fromISO: string, toISO: string): Promise<CalEvent[]>;
  create(account: Account, ev: NewEvent): Promise<CalEvent>;
  patch(account: Account, id: string, patch: Partial<Pick<NewEvent, 'title' | 'start' | 'end' | 'timeZone'>>): Promise<void>;
  remove(account: Account, id: string): Promise<void>;
}

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function fromApi(account: Account, e: any): CalEvent {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    account,
    title: e.summary ?? '(без назви)',
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    allDay,
    busy: e.transparency !== 'transparent',
    mirror: e.extendedProperties?.private?.aia_mirror === '1',
    cancelled: e.status === 'cancelled',
    location: e.location,
    description: e.description,
    link: e.htmlLink,
  };
}

export class GoogleCalendar implements CalendarPort {
  constructor(private auth: GoogleAuth) {}

  async list(account: Account, fromISO: string, toISO: string): Promise<CalEvent[]> {
    const out: CalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.auth.authedJson<{ items?: any[]; nextPageToken?: string }>(slotOf(account), BASE, {
        query: { singleEvents: 'true', orderBy: 'startTime', timeMin: fromISO, timeMax: toISO, maxResults: 250, pageToken },
      });
      for (const e of res.items ?? []) if (e.status !== 'cancelled') out.push(fromApi(account, e));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }

  async create(account: Account, ev: NewEvent): Promise<CalEvent> {
    const res = await this.auth.authedJson<any>(slotOf(account), BASE, {
      method: 'POST',
      json: {
        summary: ev.title,
        description: ev.description,
        location: ev.location,
        start: { dateTime: ev.start, timeZone: ev.timeZone },
        end: { dateTime: ev.end, timeZone: ev.timeZone },
        extendedProperties: { private: { aia: '1', ...(ev.mirror ? { aia_mirror: '1' } : {}) } },
        reminders: ev.mirror ? { useDefault: false, overrides: [] } : undefined,
      },
    });
    return fromApi(account, res);
  }

  async patch(account: Account, id: string, p: Partial<Pick<NewEvent, 'title' | 'start' | 'end' | 'timeZone'>>): Promise<void> {
    await this.auth.authedJson(slotOf(account), `${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: {
        ...(p.title !== undefined ? { summary: p.title } : {}),
        ...(p.start ? { start: { dateTime: p.start, timeZone: p.timeZone } } : {}),
        ...(p.end ? { end: { dateTime: p.end, timeZone: p.timeZone } } : {}),
      },
    });
  }

  async remove(account: Account, id: string): Promise<void> {
    await this.auth.authedJson(slotOf(account), `${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
