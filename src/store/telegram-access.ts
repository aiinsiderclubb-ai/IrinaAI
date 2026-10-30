import type { Db } from '../db/index.js';
import { kvGet, kvSet } from './kv.js';

export interface TelegramUser {
  id: number;
  name: string;
  /** also receives morning/evening reports, reminders and alerts */
  reports: boolean;
}

export interface AccessRequest {
  id: number;
  name: string;
  username?: string;
  at: string;
}

interface State {
  allowed: TelegramUser[];
  requests: AccessRequest[];
}

const KEY = 'telegram_access';
const MAX_REQUESTS = 10;

/**
 * Who besides the owner may talk to the bot. The owner adds people in the cabinet;
 * anyone else who writes is only recorded as a request (with their Telegram ID) and gets no data.
 */
export class TelegramAccess {
  constructor(
    private db: Db,
    readonly ownerId: number,
  ) {}

  private async state(): Promise<State> {
    const st = await kvGet<Partial<State>>(this.db, KEY);
    return { allowed: st?.allowed ?? [], requests: st?.requests ?? [] };
  }

  async list(): Promise<State> {
    return this.state();
  }

  async isAllowed(id: number | undefined): Promise<boolean> {
    if (id === undefined) return false;
    if (id === this.ownerId) return true;
    return (await this.state()).allowed.some((u) => u.id === id);
  }

  /** chats that receive reports and alerts: the owner plus everyone with `reports` on */
  async recipients(): Promise<number[]> {
    const extra = (await this.state()).allowed.filter((u) => u.reports && u.id !== this.ownerId).map((u) => u.id);
    return [this.ownerId, ...extra];
  }

  /** Records a stranger's attempt. Returns true the first time, so the bot answers once, not on every message. */
  async request(r: Omit<AccessRequest, 'at'>, at: Date): Promise<boolean> {
    const st = await this.state();
    if (st.requests.some((q) => q.id === r.id)) return false;
    st.requests = [{ ...r, at: at.toISOString() }, ...st.requests].slice(0, MAX_REQUESTS);
    await kvSet(this.db, KEY, st);
    return true;
  }

  async allow(u: TelegramUser): Promise<State> {
    const st = await this.state();
    const name = u.name || st.requests.find((q) => q.id === u.id)?.name || String(u.id);
    st.allowed = [...st.allowed.filter((x) => x.id !== u.id), { ...u, name }];
    st.requests = st.requests.filter((q) => q.id !== u.id);
    await kvSet(this.db, KEY, st);
    return st;
  }

  async update(id: number, patch: Partial<Omit<TelegramUser, 'id'>>): Promise<State | undefined> {
    const st = await this.state();
    const u = st.allowed.find((x) => x.id === id);
    if (!u) return undefined;
    Object.assign(u, patch);
    await kvSet(this.db, KEY, st);
    return st;
  }

  /** removes the person from the allowed list and from requests */
  async remove(id: number): Promise<State> {
    const st = await this.state();
    st.allowed = st.allowed.filter((x) => x.id !== id);
    st.requests = st.requests.filter((q) => q.id !== id);
    await kvSet(this.db, KEY, st);
    return st;
  }
}
