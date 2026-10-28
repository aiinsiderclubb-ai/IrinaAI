import type { Db } from '../db/index.js';

/** digest = automatic summary of one day of conversation */
export type MemoryKind = 'person' | 'preference' | 'fact' | 'digest';

export interface Memory {
  id: number;
  subject: string;
  content: string;
  kind: MemoryKind;
  updatedAt: Date;
}

const map = (r: any): Memory => ({ id: Number(r.id), subject: r.subject, content: r.content, kind: r.kind, updatedAt: r.updated_at });

/** What the assistant remembers about the owner's world. Small by nature: everything fits into the prompt. */
export class MemoryStore {
  constructor(private db: Db) {}

  /** Same subject + kind updates the existing note instead of piling up near-duplicates. */
  async remember(subject: string, content: string, kind: MemoryKind = 'fact'): Promise<{ memory: Memory; updated: boolean }> {
    const s = subject.trim().slice(0, 120);
    const c = content.trim().slice(0, 1000);
    const { rows: existing } = await this.db.query('SELECT * FROM memories WHERE lower(subject) = lower($1) AND kind = $2 LIMIT 1', [s, kind]);
    if (existing[0]) {
      const { rows } = await this.db.query('UPDATE memories SET content = $2, updated_at = now() WHERE id = $1 RETURNING *', [existing[0].id, c]);
      return { memory: map(rows[0]), updated: true };
    }
    const { rows } = await this.db.query('INSERT INTO memories(subject, content, kind) VALUES ($1,$2,$3) RETURNING *', [s, c, kind]);
    return { memory: map(rows[0]), updated: false };
  }

  async list(limit = 200): Promise<Memory[]> {
    const { rows } = await this.db.query('SELECT * FROM memories ORDER BY updated_at DESC LIMIT $1', [limit]);
    return rows.map(map);
  }

  async search(query: string): Promise<Memory[]> {
    const q = `%${query.trim().toLowerCase()}%`;
    const { rows } = await this.db.query('SELECT * FROM memories WHERE lower(subject) LIKE $1 OR lower(content) LIKE $1 ORDER BY updated_at DESC LIMIT 20', [q]);
    return rows.map(map);
  }

  async forget(id: number): Promise<boolean> {
    const { rows } = await this.db.query('DELETE FROM memories WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }
}
