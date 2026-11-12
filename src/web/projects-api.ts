import type { FastifyInstance } from 'fastify';
import { createProject } from '../agent/project-tools.js';
import { projectsOf } from '../projects/index.js';
import { isSyncing, reportText, startSync } from '../projects/sync.js';
import type { Services } from '../services.js';

/** Cabinet: project folders — list, add by Notion link, switch, re-read, what the assistant knows. */
export function registerProjects(app: FastifyInstance, s: Services, ownerId: number): void {
  app.get('/api/projects', async () => {
    const store = projectsOf(s);
    const active = (await s.settings.get()).activeProjectId;
    const list = await store.list();
    return {
      projects: await Promise.all(
        list.map(async (p) => ({
          id: p.id,
          name: p.name,
          active: p.id === active,
          notionUrl: p.notionUrl ?? null,
          summary: p.summary,
          syncedAt: p.syncedAt ?? null,
          syncing: isSyncing(p.id),
          syncError: p.syncError || null,
          counts: await store.countMaterials(p.id),
        })),
      ),
    };
  });

  app.post<{ Body: { name?: string; notionLink?: string } }>('/api/projects', async (req, reply) => {
    const { name, notionLink } = req.body ?? {};
    if (!name?.trim() && !notionLink?.trim()) return reply.code(400).send({ error: 'Потрібна назва або посилання на Notion' });
    const r = await createProject(s, ownerId, { name: name?.trim() || undefined, notion_link: notionLink?.trim() || undefined });
    if (r.status === 'error' || r.status === 'no_access' || r.status === 'exists') return reply.code(400).send({ error: r.note });
    return { ok: true, project: r.project, note: r.note.replace(/ Скажи про це коротко\.$/, '') };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/activate', async (req, reply) => {
    const p = await projectsOf(s).get(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'Проєкт не знайдено' });
    await s.settings.update({ activeProjectId: p.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/sync', async (req, reply) => {
    const p = await projectsOf(s).get(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'Проєкт не знайдено' });
    if (!p.notionId) return reply.code(400).send({ error: 'У проєкту немає сторінки Notion' });
    const started = startSync(s, p, async (r) => {
      if (!(r instanceof Error)) s.log.info('project_synced', { project: p.id, text: reportText(p, r) });
    });
    return { ok: true, started };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/materials', async (req) => {
    const mats = await projectsOf(s).listMaterials(Number(req.params.id), { limit: 300 });
    return {
      materials: mats.map((m) => ({ id: m.id, kind: m.kind, title: m.title, source: m.source ?? null, chars: m.text.length, updatedAt: m.updatedAt })),
    };
  });
}
