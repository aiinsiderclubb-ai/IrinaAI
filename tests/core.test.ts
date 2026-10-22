import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, signState, verifyState } from '../src/lib/crypto.js';
import { parseLocal } from '../src/lib/time.js';
import { isDuplicateTitle } from '../src/notion/dedupe.js';
import { loadConfig } from '../src/config.js';
import { TokenStore } from '../src/store/tokens.js';
import { createPgliteDb, migrate } from '../src/db/index.js';
import { PendingStore } from '../src/store/pending.js';

const key = randomBytes(32).toString('base64');

describe('crypto', () => {
  it('round-trips and rejects tampering', () => {
    const c = encrypt('refresh-token-123', key);
    expect(c).not.toContain('refresh-token');
    expect(decrypt(c, key)).toBe('refresh-token-123');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
    expect(() => decrypt(c, randomBytes(32).toString('base64'))).toThrow();
  });

  it('accepts any non-empty secret as key material (hashed), still rejects a different one', () => {
    const c = encrypt('x', 'render-generated-not-base64!!');
    expect(decrypt(c, 'render-generated-not-base64!!')).toBe('x');
    expect(() => decrypt(c, 'another-secret')).toThrow();
    expect(() => encrypt('x', '')).toThrow();
  });

  it('signs OAuth state with expiry', () => {
    const t = signState({ slot: 'instagram' }, 'secret-secret-secret', 60, 1_000_000);
    expect(verifyState(t, 'secret-secret-secret', 1_000_000 + 30_000)).toEqual({ slot: 'instagram' });
    expect(verifyState(t, 'secret-secret-secret', 1_000_000 + 61_000)).toBeNull();
    expect(verifyState(t, 'other-secret-secret!', 1_000_000)).toBeNull();
    expect(verifyState(t.replace(/.$/, 'x'), 'secret-secret-secret', 1_000_000)).toBeNull();
  });
});

describe('time', () => {
  it('reads wall time in the owner zone, DST-aware', () => {
    expect(parseLocal('2026-10-23T08:00', 'Europe/Kyiv').toUTC().toISO()).toBe('2026-10-23T05:00:00.000Z'); // UTC+3
    expect(parseLocal('2026-10-26T08:00', 'Europe/Kyiv').toUTC().toISO()).toBe('2026-10-26T06:00:00.000Z'); // after 25.10 -> UTC+2
    expect(parseLocal('2026-10-23T08:00:00Z', 'Europe/Kyiv').toISO()).toContain('11:00');
    expect(() => parseLocal('not a date', 'Europe/Kyiv')).toThrow();
  });
});

describe('duplicate detection', () => {
  it('matches near-identical titles, not different tasks', () => {
    expect(isDuplicateTitle('Підготувати презентацію для інвесторів', 'підготувати презентацію для інвесторів!')).toBe(true);
    expect(isDuplicateTitle('Надіслати договір', 'Надіслати договір клієнту Alpha')).toBe(true);
    expect(isDuplicateTitle('Надіслати договір', 'Забронювати квитки')).toBe(false);
    expect(isDuplicateTitle('Дзвінок', 'Дзвінок з бухгалтером')).toBe(false); // too short to count as containment
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: key, APP_SECRET: 'a'.repeat(16), TELEGRAM_BOT_TOKEN: 't',
    OWNER_TELEGRAM_ID: '42', OPENAI_API_KEY: 'k',
  };
  it('requires webhook settings in webhook mode, treats empty as unset', () => {
    expect(() => loadConfig(base)).toThrow(/PUBLIC_URL/);
    const cfg = loadConfig({ ...base, TELEGRAM_MODE: 'polling', ELEVENLABS_API_KEY: '' });
    expect(cfg.ELEVENLABS_API_KEY).toBeUndefined();
    expect(cfg.OWNER_TELEGRAM_ID).toBe(42);
  });
  it('reports every invalid variable', () => {
    expect(() => loadConfig({ TELEGRAM_MODE: 'polling' })).toThrow(/DATABASE_URL[\s\S]*OPENAI_API_KEY/);
  });
});

describe('stores', () => {
  it('encrypts tokens at rest and keeps omitted fields on partial save', async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const tokens = new TokenStore(db, key);
    await tokens.save('instagram', { accessToken: 'AT1', expiresAt: new Date('2026-12-01'), meta: { userId: '1' } });
    const raw = (await db.query('SELECT access_token FROM oauth_tokens')).rows[0]!.access_token as string;
    expect(raw).not.toContain('AT1');
    await tokens.save('instagram', { meta: { broken: true } });
    const t = await tokens.get('instagram');
    expect(t?.accessToken).toBe('AT1');
    expect(t?.meta).toEqual({ userId: '1', broken: true });
  });

  it('claims a pending action exactly once', async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const p = new PendingStore(db);
    const a = await p.create('task.create', { title: 'x' }, 'x');
    const [r1, r2] = await Promise.all([p.claim(a.id), p.claim(a.id)]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    expect(await p.cancel(a.id)).toBe(false);
  });
});
