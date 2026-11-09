import type { GoogleAuth } from './google-auth.js';
import { HttpError } from '../lib/http.js';

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
  /** one occurrence of a repeating event */
  recurring?: boolean;
  location?: string;
  description?: string;
  link?: string;
}

export type EventPatch = Partial<Pick<NewEvent, 'title' | 'start' | 'end' | 'timeZone' | 'location' | 'description'>> & {
  /** start/end are dates (YYYY-MM-DD), not date-times */
  allDay?: boolean;
};

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
  get(account: Account, id: string): Promise<CalEvent | undefined>;
  patch(account: Account, id: string, patch: EventPatch): Promise<void>;
  remove(account: Account, id: string): Promise<void>;
  calendars?(account: Account): Promise<CalendarInfo[]>;
}

const API = 'https://www.googleapis.com/calendar/v3';

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  /** owner | writer | reader | freeBusyReader */
  access: string;
}

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
    recurring: Boolean(e.recurringEventId),
    location: e.location,
    description: e.description,
    link: e.htmlLink,
  };
}

export class GoogleCalendar implements CalendarPort {
  constructor(
    private auth: GoogleAuth,
    private calendarOf: (a: Account) => string = () => 'primary',
  ) {}

  private base(account: Account) {
    return `${API}/calendars/${encodeURIComponent(this.calendarOf(account))}/events`;
  }

  /** Calendars the connected Google account can see: its own and the ones shared with it. */
  async calendars(account: Account): Promise<CalendarInfo[]> {
    const res = await this.auth.authedJson<{ items?: any[] }>(slotOf(account), `${API}/users/me/calendarList`, { query: { maxResults: 250 } });
    return (res.items ?? []).map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: Boolean(c.primary), access: c.accessRole }));
  }

  async list(account: Account, fromISO: string, toISO: string): Promise<CalEvent[]> {
    const out: CalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.auth.authedJson<{ items?: any[]; nextPageToken?: string }>(slotOf(account), this.base(account), {
        query: { singleEvents: 'true', orderBy: 'startTime', timeMin: fromISO, timeMax: toISO, maxResults: 250, pageToken },
      });
      for (const e of res.items ?? []) if (e.status !== 'cancelled') out.push(fromApi(account, e));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }

  async create(account: Account, ev: NewEvent): Promise<CalEvent> {
    const res = await this.auth.authedJson<any>(slotOf(account), this.base(account), {
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

  async get(account: Account, id: string): Promise<CalEvent | undefined> {
    try {
      const e = await this.auth.authedJson<any>(slotOf(account), `${this.base(account)}/${encodeURIComponent(id)}`);
      return e.status === 'cancelled' ? undefined : fromApi(account, e);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return undefined;
      throw err;
    }
  }

  async patch(account: Account, id: string, p: EventPatch): Promise<void> {
    const time = (v: string) => (p.allDay ? { date: v.slice(0, 10), dateTime: null } : { dateTime: v, timeZone: p.timeZone, date: null });
    await this.auth.authedJson(slotOf(account), `${this.base(account)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: {
        ...(p.title !== undefined ? { summary: p.title } : {}),
        ...(p.location !== undefined ? { location: p.location } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.start ? { start: time(p.start) } : {}),
        ...(p.end ? { end: time(p.end) } : {}),
      },
    });
  }

  async remove(account: Account, id: string): Promise<void> {
    await this.auth.authedJson(slotOf(account), `${this.base(account)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
