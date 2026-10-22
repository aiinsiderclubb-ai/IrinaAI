import type { Account, CalEvent, CalendarPort, NewEvent } from '../../src/integrations/google-calendar.js';

export class FakeCalendar implements CalendarPort {
  events: Record<Account, CalEvent[]> = { work: [], personal: [] };
  private n = 0;
  calls = { create: 0, patch: 0, remove: 0 };

  add(account: Account, e: Partial<CalEvent> & { title: string; start: string; end: string }): CalEvent {
    const ev: CalEvent = { id: `${account}-${++this.n}`, account, allDay: false, busy: true, mirror: false, cancelled: false, ...e };
    this.events[account].push(ev);
    return ev;
  }

  async list(account: Account, from: string, to: string): Promise<CalEvent[]> {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    return this.events[account].filter((e) => new Date(e.end).getTime() > f && new Date(e.start).getTime() < t).map((e) => ({ ...e }));
  }

  async create(account: Account, ev: NewEvent): Promise<CalEvent> {
    this.calls.create++;
    return this.add(account, { title: ev.title, start: ev.start, end: ev.end, mirror: ev.mirror ?? false, location: ev.location });
  }

  async patch(account: Account, id: string, p: Partial<NewEvent>): Promise<void> {
    this.calls.patch++;
    const e = this.events[account].find((x) => x.id === id);
    if (!e) throw new Error('404');
    if (p.title !== undefined) e.title = p.title;
    if (p.start) e.start = p.start;
    if (p.end) e.end = p.end;
  }

  async remove(account: Account, id: string): Promise<void> {
    this.calls.remove++;
    this.events[account] = this.events[account].filter((e) => e.id !== id);
  }
}
