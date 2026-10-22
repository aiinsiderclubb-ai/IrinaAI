import type { Db } from '../db/index.js';

export interface PendingAction<P = any> {
  id: string;
  kind: string;
  payload: P;
  summary: string;
  status: 'pending' | 'done' | 'cancelled' | 'failed' | 'expired';
  chatId?: number;
  messageId?: number;
  result?: string;
  createdAt: Date;
}

const map = (r: any): PendingAction => ({
  id: r.id,
  kind: r.kind,
  payload: r.payload,
  summary: r.summary,
  status: r.status,
  chatId: r.chat_id ? Number(r.chat_id) : undefined,
  messageId: r.message_id ? Number(r.message_id) : undefined,
  result: r.result ?? undefined,
  createdAt: r.created_at,
});

export class PendingStore {
  constructor(private db: Db) {}

  async create(kind: string, payload: unknown, summary: string, chatId?: number): Promise<PendingAction> {
    const { rows } = await this.db.query(
      `INSERT INTO pending_actions(kind, payload, summary, chat_id) VALUES ($1,$2::jsonb,$3,$4) RETURNING *`,
      [kind, JSON.stringify(payload), summary, chatId ?? null],
    );
    return map(rows[0]);
  }

  async get(id: string): Promise<PendingAction | undefined> {
    const { rows } = await this.db.query('SELECT * FROM pending_actions WHERE id = $1', [id]);
    return rows[0] ? map(rows[0]) : undefined;
  }

  async setMessage(id: string, messageId: number): Promise<void> {
    await this.db.query('UPDATE pending_actions SET message_id = $2 WHERE id = $1', [id, messageId]);
  }

  async updatePayload(id: string, payload: unknown, summary: string): Promise<void> {
    await this.db.query(`UPDATE pending_actions SET payload = $2::jsonb, summary = $3 WHERE id = $1 AND status = 'pending'`, [
      id,
      JSON.stringify(payload),
      summary,
    ]);
  }

  /** Atomically claims a pending action. Returns undefined when it was already handled (double tap). */
  async claim(id: string): Promise<PendingAction | undefined> {
    const { rows } = await this.db.query(
      `UPDATE pending_actions SET status = 'done', resolved_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id],
    );
    return rows[0] ? map(rows[0]) : undefined;
  }

  async finish(id: string, status: 'done' | 'failed', result: string): Promise<void> {
    await this.db.query('UPDATE pending_actions SET status = $2, result = $3, resolved_at = now() WHERE id = $1', [id, status, result]);
  }

  async cancel(id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE pending_actions SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async expireOlderThan(hours: number): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE pending_actions SET status = 'expired', resolved_at = now()
       WHERE status = 'pending' AND created_at < now() - ($1 || ' hours')::interval RETURNING id`,
      [String(hours)],
    );
    return rows.length;
  }

  async listPending(): Promise<PendingAction[]> {
    const { rows } = await this.db.query(`SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at`);
    return rows.map(map);
  }
}
