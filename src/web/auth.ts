import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import { signState, verifyState } from '../lib/crypto.js';

export const SESSION_COOKIE = 'aia_session';
export const SESSION_DAYS = 30;

const sha = (s: string) => createHash('sha256').update(s).digest();

export function issueSession(secret: string, ownerId: number, nowMs = Date.now()): string {
  return signState({ sub: String(ownerId), kind: 'web' }, secret, SESSION_DAYS * 86400, nowMs);
}

export function isValidSession(value: string | undefined, secret: string, ownerId: number, nowMs = Date.now()): boolean {
  if (!value) return false;
  const data = verifyState(value, secret, nowMs);
  return data?.kind === 'web' && data.sub === String(ownerId);
}

/** Single-use, 10-minute login link token. */
export async function createLoginToken(db: Db, ttlMin = 10): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO web_login_tokens(token_hash, expires_at) VALUES ($1, now() + ($2 || ' minutes')::interval)`, [
    sha(token).toString('hex'),
    String(ttlMin),
  ]);
  await db.query(`DELETE FROM web_login_tokens WHERE expires_at < now() - interval '1 day'`);
  return token;
}

export async function consumeLoginToken(db: Db, token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const { rows } = await db.query(
    `UPDATE web_login_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING token_hash`,
    [sha(token).toString('hex')],
  );
  return rows.length > 0;
}

export function passwordMatches(given: string, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  return timingSafeEqual(sha(given), sha(expected));
}

/** Small in-memory brute-force guard for the password form. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 5,
    private windowMs = 15 * 60_000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    return recent.length < this.max;
  }
  fail(key: string, now = Date.now()): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
  }
}
