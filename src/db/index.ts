import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** multi-statement script, no params */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const ssl = /sslmode=require|render\.com/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, max: 8, ssl });
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]) as any,
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

/** In-process Postgres (WASM) for tests and local dev without a server. */
export async function createPgliteDb(): Promise<Db> {
  const lite = new PGlite();
  await lite.waitReady;
  return {
    query: (sql, params) => lite.query(sql, params as unknown[]) as any,
    exec: async (sql) => void (await lite.exec(sql)),
    close: () => lite.close(),
  };
}

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(db: Db, dir = join(here, 'migrations')): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await db.exec(readFileSync(join(dir, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}
