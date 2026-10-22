import type { Db } from '../db/index.js';

export async function kvGet<T>(db: Db, key: string): Promise<T | undefined> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM kv WHERE key = $1', [key]);
  return rows[0]?.value;
}

export async function kvSet(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO kv(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
