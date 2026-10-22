import type { Db } from '../db/index.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class MessageStore {
  constructor(private db: Db) {}

  async add(chatId: number, role: ChatMessage['role'], content: string): Promise<void> {
    await this.db.query('INSERT INTO messages(chat_id, role, content) VALUES ($1,$2,$3)', [chatId, role, content.slice(0, 4000)]);
  }

  /** Recent turns, oldest first; only the last `maxAgeHours` count as context. */
  async recent(chatId: number, limit = 14, maxAgeHours = 12): Promise<ChatMessage[]> {
    const { rows } = await this.db.query<ChatMessage>(
      `SELECT role, content FROM messages
       WHERE chat_id = $1 AND created_at > now() - ($3 || ' hours')::interval
       ORDER BY id DESC LIMIT $2`,
      [chatId, limit, String(maxAgeHours)],
    );
    return rows.reverse();
  }

  /** Data minimisation: drop old chat history. */
  async prune(olderThanDays = 30): Promise<void> {
    await this.db.query(`DELETE FROM messages WHERE created_at < now() - ($1 || ' days')::interval`, [String(olderThanDays)]);
    await this.db.query(`DELETE FROM processed_updates WHERE at < now() - interval '3 days'`);
  }

  /** @returns true if the update is new (first time seen). */
  async markUpdate(updateId: number): Promise<boolean> {
    const { rows } = await this.db.query(
      'INSERT INTO processed_updates(update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id',
      [updateId],
    );
    return rows.length > 0;
  }
}
