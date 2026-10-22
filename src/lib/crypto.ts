import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A base64 32-byte key is used as is; any other secret string (e.g. Render's generated value) is hashed to 32 bytes. */
function keyFrom(secret: string): Buffer {
  if (!secret) throw new Error('ENCRYPTION_KEY is empty');
  const raw = Buffer.from(secret, 'base64');
  return raw.length === 32 ? raw : createHash('sha256').update(secret).digest();
}

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encrypt(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string, keyB64: string): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(keyB64), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Signed, expiring token for OAuth `state`. */
export function signState(data: Record<string, string>, secret: string, ttlSec = 900, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(nowMs / 1000) + ttlSec })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(token: string, secret: string, nowMs = Date.now()): Record<string, string> | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string | number>;
    if (typeof data.exp !== 'number' || data.exp * 1000 < nowMs) return null;
    const { exp: _exp, ...rest } = data;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
  } catch {
    return null;
  }
}
