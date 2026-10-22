import type { Db } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';

export type Slot = 'google:work' | 'google:personal' | 'google:youtube' | 'instagram';

export interface StoredToken {
  slot: Slot;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
  meta: Record<string, any>;
  updatedAt: Date;
}

export class TokenStore {
  constructor(
    private db: Db,
    private key: string,
  ) {}

  async get(slot: Slot): Promise<StoredToken | undefined> {
    const { rows } = await this.db.query('SELECT * FROM oauth_tokens WHERE slot = $1', [slot]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      slot,
      accessToken: r.access_token ? decrypt(r.access_token, this.key) : undefined,
      refreshToken: r.refresh_token ? decrypt(r.refresh_token, this.key) : undefined,
      expiresAt: r.expires_at ?? undefined,
      scope: r.scope ?? undefined,
      meta: r.meta ?? {},
      updatedAt: r.updated_at,
    };
  }

  /** Partial update: omitted fields are kept, `null` clears. */
  async save(
    slot: Slot,
    t: { accessToken?: string | null; refreshToken?: string | null; expiresAt?: Date | null; scope?: string | null; meta?: Record<string, any> },
  ): Promise<void> {
    const prev = await this.get(slot);
    const pick = <V>(next: V | null | undefined, old: V | undefined) => (next === undefined ? old : (next ?? undefined));
    const access = pick(t.accessToken, prev?.accessToken);
    const refresh = pick(t.refreshToken, prev?.refreshToken);
    await this.db.query(
      `INSERT INTO oauth_tokens(slot, access_token, refresh_token, expires_at, scope, meta, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
       ON CONFLICT (slot) DO UPDATE SET access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
         expires_at=EXCLUDED.expires_at, scope=EXCLUDED.scope, meta=EXCLUDED.meta, updated_at=now()`,
      [
        slot,
        access ? encrypt(access, this.key) : null,
        refresh ? encrypt(refresh, this.key) : null,
        pick(t.expiresAt, prev?.expiresAt) ?? null,
        pick(t.scope, prev?.scope) ?? null,
        JSON.stringify({ ...prev?.meta, ...t.meta }),
      ],
    );
  }

  async delete(slot: Slot): Promise<void> {
    await this.db.query('DELETE FROM oauth_tokens WHERE slot = $1', [slot]);
  }

  async connected(): Promise<Slot[]> {
    const { rows } = await this.db.query<{ slot: Slot }>('SELECT slot FROM oauth_tokens WHERE refresh_token IS NOT NULL OR access_token IS NOT NULL');
    return rows.map((r) => r.slot);
  }
}
