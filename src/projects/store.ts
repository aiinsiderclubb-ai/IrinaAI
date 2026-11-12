import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Llm } from '../integrations/openai.js';

export type MaterialKind = 'notion' | 'notion_db' | 'file' | 'link' | 'chat' | 'note' | 'report';

export interface Project {
  id: number;
  name: string;
  notionId?: string;
  notionUrl?: string;
  /** the project card: goal, brief essentials, criteria, status, open questions */
  summary: string;
  status: 'active' | 'archived';
  syncedAt?: Date;
  syncError?: string;
  createdAt: Date;
}

export interface Material {
  id: number;
  projectId?: number;
  kind: MaterialKind;
  title: string;
  source?: string;
  text: string;
  meta: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchHit {
  materialId: number;
  title: string;
  kind: MaterialKind;
  source?: string;
  text: string;
  score: number;
}

const toProject = (r: any): Project => ({
  id: Number(r.id),
  name: r.name,
  notionId: r.notion_id ?? undefined,
  notionUrl: r.notion_url ?? undefined,
  summary: r.summary ?? '',
  status: r.status,
  syncedAt: r.synced_at ?? undefined,
  syncError: r.sync_error ?? undefined,
  createdAt: r.created_at,
});

const toMaterial = (r: any): Material => ({
  id: Number(r.id),
  projectId: r.project_id == null ? undefined : Number(r.project_id),
  kind: r.kind,
  title: r.title,
  source: r.source ?? undefined,
  text: r.text ?? '',
  meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta ?? {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

const CHUNK = 1200;

/** Splits a material into pieces of ~1200 characters on paragraph boundaries; each piece carries the nearest heading. */
export function chunkText(title: string, text: string): string[] {
  const blocks = text.split(/\n{2,}/).flatMap((b) => (b.length > CHUNK * 1.4 ? b.split('\n') : [b]));
  const out: string[] = [];
  let heading = '';
  let cur = '';
  const flush = () => {
    if (cur.trim()) out.push(`[${title}${heading && !cur.startsWith(heading) ? ` · ${heading.replace(/^#+\s*/, '')}` : ''}]\n${cur.trim()}`);
    cur = '';
  };
  for (const raw of blocks) {
    const b = raw.trim();
    if (!b) continue;
    if (/^#{1,4}\s/.test(b)) {
      flush();
      heading = b.split('\n')[0]!;
    }
    for (let i = 0; i < b.length; i += CHUNK * 1.4) {
      const piece = b.slice(i, i + CHUNK * 1.4);
      if (cur.length + piece.length > CHUNK) flush();
      cur += `${cur ? '\n\n' : ''}${piece}`;
    }
  }
  flush();
  return out.slice(0, 400);
}

const toBytes = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBytes = (b: Uint8Array): Float32Array => new Float32Array(Uint8Array.from(b).buffer);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const words = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];

/** Projects and their materials (Notion pages, files, web pages, chat), searchable by meaning. */
export class ProjectStore {
  constructor(
    private db: Db,
    /** the model may be swapped at runtime (a new key in the cabinet) */
    private llm: () => Llm,
  ) {}

  // ---------- projects ----------

  async create(p: { name: string; notionId?: string; notionUrl?: string }): Promise<Project> {
    const { rows } = await this.db.query('INSERT INTO projects(name, notion_id, notion_url) VALUES ($1,$2,$3) RETURNING *', [p.name.trim().slice(0, 200), p.notionId ?? null, p.notionUrl ?? null]);
    return toProject(rows[0]);
  }

  async get(id: number): Promise<Project | undefined> {
    const { rows } = await this.db.query('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] ? toProject(rows[0]) : undefined;
  }

  async list(includeArchived = false): Promise<Project[]> {
    const { rows } = await this.db.query(`SELECT * FROM projects ${includeArchived ? '' : "WHERE status = 'active'"} ORDER BY created_at`);
    return rows.map(toProject);
  }

  /** exact name first, then a part of it */
  async find(name: string): Promise<Project | undefined> {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    const all = await this.list();
    return all.find((p) => p.name.toLowerCase() === q) ?? all.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
  }

  async findByNotion(notionId: string): Promise<Project | undefined> {
    const { rows } = await this.db.query("SELECT * FROM projects WHERE replace(notion_id, '-', '') = $1 AND status = 'active' LIMIT 1", [notionId.replace(/-/g, '')]);
    return rows[0] ? toProject(rows[0]) : undefined;
  }

  async update(id: number, patch: Partial<Pick<Project, 'name' | 'summary' | 'status' | 'notionId' | 'notionUrl' | 'syncError'>> & { syncedAt?: Date | null }): Promise<void> {
    const cols: Record<string, unknown> = {
      name: patch.name,
      summary: patch.summary,
      status: patch.status,
      notion_id: patch.notionId,
      notion_url: patch.notionUrl,
      sync_error: patch.syncError,
      synced_at: patch.syncedAt,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!set.length) return;
    await this.db.query(`UPDATE projects SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...set.map(([, v]) => v)]);
  }

  // ---------- materials ----------

  /**
   * Adds a material, or updates the one with the same project + kind + source. Unchanged text is not re-indexed.
   * Returns `changed: false` when nothing new was learned.
   */
  async addMaterial(m: { projectId?: number; kind: MaterialKind; title: string; source?: string; text: string; meta?: Record<string, unknown> }): Promise<{ material: Material; changed: boolean }> {
    const text = m.text.slice(0, 600_000);
    const hash = sha1(`${m.title}\n${text}`);
    if (m.source) {
      const { rows } = await this.db.query(
        'SELECT * FROM materials WHERE project_id IS NOT DISTINCT FROM $1 AND kind = $2 AND source = $3 LIMIT 1',
        [m.projectId ?? null, m.kind, m.source],
      );
      const old = rows[0];
      if (old && old.hash === hash) {
        if (m.meta) await this.db.query('UPDATE materials SET meta = $2 WHERE id = $1', [old.id, JSON.stringify({ ...toMaterial(old).meta, ...m.meta })]);
        return { material: toMaterial(old), changed: false };
      }
      if (old) {
        const { rows: up } = await this.db.query('UPDATE materials SET title = $2, text = $3, meta = $4, hash = $5, updated_at = now() WHERE id = $1 RETURNING *', [
          old.id,
          m.title.slice(0, 300),
          text,
          JSON.stringify({ ...toMaterial(old).meta, ...m.meta }),
          hash,
        ]);
        const material = toMaterial(up[0]);
        await this.index(material);
        return { material, changed: true };
      }
    }
    const { rows } = await this.db.query('INSERT INTO materials(project_id, kind, title, source, text, meta, hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [
      m.projectId ?? null,
      m.kind,
      m.title.slice(0, 300),
      m.source ?? null,
      text,
      JSON.stringify(m.meta ?? {}),
      hash,
    ]);
    const material = toMaterial(rows[0]);
    await this.index(material);
    return { material, changed: true };
  }

  async getMaterial(id: number): Promise<Material | undefined> {
    const { rows } = await this.db.query('SELECT * FROM materials WHERE id = $1', [id]);
    return rows[0] ? toMaterial(rows[0]) : undefined;
  }

  /** newest first; `projectId: null` = materials not tied to a project */
  async listMaterials(projectId: number | null, opts: { kinds?: MaterialKind[]; limit?: number } = {}): Promise<Material[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id IS NOT DISTINCT FROM $1';
    if (opts.kinds?.length) {
      params.push(opts.kinds);
      where += ` AND kind = ANY($${params.length})`;
    }
    params.push(opts.limit ?? 200);
    const { rows } = await this.db.query(`SELECT * FROM materials WHERE ${where} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
    return rows.map(toMaterial);
  }

  async countMaterials(projectId: number): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ kind: string; n: string }>('SELECT kind, count(*) AS n FROM materials WHERE project_id = $1 GROUP BY kind', [projectId]);
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  }

  async deleteMaterial(id: number): Promise<void> {
    await this.db.query('DELETE FROM materials WHERE id = $1', [id]);
  }

  async moveMaterial(id: number, projectId: number): Promise<void> {
    await this.db.query('UPDATE materials SET project_id = $2 WHERE id = $1', [id, projectId]);
    await this.db.query('UPDATE material_chunks SET project_id = $2 WHERE material_id = $1', [id, projectId]);
  }

  // ---------- search ----------

  private async index(m: Material): Promise<void> {
    await this.db.query('DELETE FROM material_chunks WHERE material_id = $1', [m.id]);
    const chunks = chunkText(m.title, m.text || m.title);
    let vectors: number[][] | undefined;
    const llm = this.llm();
    if (llm.embed && chunks.length) {
      try {
        vectors = await llm.embed(chunks);
      } catch {
        vectors = undefined; // keyword search still works
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const v = vectors?.[i];
      await this.db.query('INSERT INTO material_chunks(material_id, project_id, idx, text, embedding) VALUES ($1,$2,$3,$4,$5)', [
        m.id,
        m.projectId ?? null,
        i,
        chunks[i],
        v ? toBytes(v) : null,
      ]);
    }
  }

  /**
   * The pieces of materials closest to `query` by meaning (embeddings) plus a bonus for matching words.
   * `projectId` undefined = everywhere; at most two pieces per material.
   */
  async search(query: string, opts: { projectId?: number; limit?: number; kinds?: MaterialKind[] } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 6;
    const llm = this.llm();
    let qv: Float32Array | undefined;
    if (llm.embed) {
      try {
        qv = new Float32Array((await llm.embed([query]))[0]!);
      } catch {
        qv = undefined;
      }
    }
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.projectId !== undefined) {
      params.push(opts.projectId);
      where.push(`c.project_id = $${params.length}`);
    }
    if (opts.kinds?.length) {
      params.push(opts.kinds);
      where.push(`m.kind = ANY($${params.length})`);
    }
    const { rows } = await this.db.query(
      `SELECT c.material_id, c.text, c.embedding, m.title, m.kind, m.source FROM material_chunks c JOIN materials m ON m.id = c.material_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT 20000`,
      params,
    );
    const ws = words(query);
    const scored = rows.map((r: any) => {
      const lower = String(r.text).toLowerCase();
      const kw = ws.length ? ws.filter((w) => lower.includes(w)).length / ws.length : 0;
      const sem = qv && r.embedding ? cosine(qv, fromBytes(r.embedding)) : 0;
      return { materialId: Number(r.material_id), title: r.title, kind: r.kind, source: r.source ?? undefined, text: r.text, score: (qv ? sem : 0) + kw * (qv ? 0.15 : 1) };
    });
    scored.sort((a, b) => b.score - a.score);
    const per = new Map<number, number>();
    const out: SearchHit[] = [];
    for (const h of scored) {
      if (h.score <= (qv ? 0.2 : 0)) break;
      const n = per.get(h.materialId) ?? 0;
      if (n >= 2) continue;
      per.set(h.materialId, n + 1);
      out.push({ ...h, score: Math.round(h.score * 1000) / 1000 });
      if (out.length >= limit) break;
    }
    return out;
  }
}
