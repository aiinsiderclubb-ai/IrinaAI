import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { baseUrl } from '../config.js';
import { mcpListTools } from '../integrations/mcp.js';
import { applyIntegrations } from '../integrations/runtime.js';
import { httpJson } from '../lib/http.js';
import { errMsg } from '../lib/log.js';
import { signState } from '../lib/crypto.js';
import { NotionHttp } from '../notion/client.js';
import { clearContextCache } from '../notion/context.js';
import { NotionRepo } from '../notion/repo.js';
import { discoverTasksSchema, projectOptions, type NotionDatabaseMeta } from '../notion/schema.js';
import type { Services } from '../services.js';
import { mask, type CustomIntegration, type IntegrationConfig } from '../store/integrations.js';

const httpsUrl = (dev: boolean) =>
  z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith('https://') || (dev && /^http:\/\/(localhost|127\.0\.0\.1)/.test(u)), 'потрібна адреса https://');

const title = (rich: any[] | undefined) => (rich ?? []).map((t) => t.plain_text ?? '').join('') || 'Без назви';

/**
 * Опції → Підключення: everything configurable from the cabinet. Secrets are never sent back, only masked.
 * Notion stays read-only until the owner switches writing on.
 */
export function registerIntegrations(app: FastifyInstance, s: Services): void {
  const store = s.integrations!;
  const dev = s.cfg.NODE_ENV !== 'production';
  const ownerId = s.cfg.OWNER_TELEGRAM_ID;
  const base = baseUrl(s.cfg);
  const state = (slot: string) => signState({ slot, owner: String(ownerId) }, s.cfg.APP_SECRET);
  const apply = async () => {
    await applyIntegrations(s);
    clearContextCache();
  };

  const view = async () => {
    const ic: IntegrationConfig = await store.get();
    const st = await s.settings.get();
    const slot = async (name: 'google:work' | 'google:personal' | 'google:youtube' | 'instagram') => {
      const t = await s.tokens.get(name);
      if (!t || !(t.refreshToken || t.accessToken)) return 'off';
      return t.meta.broken ? 'broken' : 'on';
    };
    const fromEnv = (v?: string) => Boolean(v);
    return {
      notion: {
        state: !s.notionApi ? 'off' : st.notion ? 'on' : 'setup',
        token: mask(ic.notion?.token) ?? (fromEnv(s.cfg.NOTION_TOKEN) ? 'з налаштувань сервера' : undefined),
        readOnly: ic.notion?.readOnly !== false,
        tasksDb: st.notion?.tasks.db,
        mapping: st.notion?.tasks,
        contextPages: st.notionContextPages,
        helperDbs: { decisions: Boolean(st.notion?.decisions), waiting: Boolean(st.notion?.waiting), finance: Boolean(st.notion?.finance), notes: Boolean(st.notion?.notes) },
      },
      google: {
        configured: Boolean(s.googleAuth),
        clientId: ic.google?.clientId ?? (s.cfg.GOOGLE_CLIENT_ID ? 'з налаштувань сервера' : undefined),
        clientSecret: mask(ic.google?.clientSecret),
        redirectUri: `${base}/oauth/google/callback`,
        readOnly: ic.google ? ic.google.readOnly !== false : false,
        calendars: { work: ic.google?.calendars?.work ?? 'primary', personal: ic.google?.calendars?.personal ?? 'primary' },
        accounts: {
          work: { state: await slot('google:work'), connectUrl: s.googleAuth?.authUrl('google:work', state('google:work')) },
          personal: { state: await slot('google:personal'), connectUrl: s.googleAuth?.authUrl('google:personal', state('google:personal')) },
          youtube: { state: await slot('google:youtube'), connectUrl: s.googleAuth?.authUrl('google:youtube', state('google:youtube')) },
        },
      },
      meta: {
        configured: Boolean(s.instagram),
        appId: ic.meta?.appId ?? (s.cfg.META_APP_ID ? 'з налаштувань сервера' : undefined),
        appSecret: mask(ic.meta?.appSecret),
        redirectUri: `${base}/oauth/instagram/callback`,
        instagram: { state: await slot('instagram'), connectUrl: s.instagram?.authUrl(state('instagram')), expiresAt: (await s.tokens.get('instagram'))?.expiresAt },
      },
      elevenlabs: { state: ic.elevenlabs?.apiKey || s.cfg.ELEVENLABS_API_KEY ? 'on' : 'off', apiKey: mask(ic.elevenlabs?.apiKey) ?? (s.cfg.ELEVENLABS_API_KEY ? 'з налаштувань сервера' : undefined) },
      openai: { apiKey: mask(ic.openai?.apiKey) ?? 'з налаштувань сервера', model: s.cfg.OPENAI_MODEL },
      custom: (ic.custom ?? []).map((c: CustomIntegration) =>
        c.type === 'webhook'
          ? { ...c, secret: mask(c.secret) }
          : { ...c, authorization: mask(c.authorization) },
      ),
    };
  };

  app.get('/api/integrations', async () => view());

  // ---------- keys of built-in services ----------

  const keyBodies = {
    google: z.object({ clientId: z.string().trim().min(10), clientSecret: z.string().trim() }),
    meta: z.object({ appId: z.string().trim().min(5), appSecret: z.string().trim() }),
    elevenlabs: z.object({ apiKey: z.string().trim().min(10) }),
    openai: z.object({ apiKey: z.string().trim().min(20) }),
  } as const;

  /** cheap read-only call to check a key before saving it */
  const verify: Partial<Record<keyof typeof keyBodies, (v: any) => Promise<void>>> = {
    elevenlabs: async (v) => void (await httpJson('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': v.apiKey }, retries: 0 })),
    openai: async (v) => void (await httpJson('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${v.apiKey}` }, retries: 0 })),
  };

  app.put<{ Params: { section: string } }>('/api/integrations/:section', async (req, reply) => {
    const section = req.params.section as keyof typeof keyBodies;
    const schema = keyBodies[section];
    if (!schema) return reply.code(404).send({ error: 'unknown section' });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    try {
      await verify[section]?.(parsed.data);
    } catch (e) {
      return reply.code(400).send({ error: `Ключ не підійшов: ${errMsg(e).slice(0, 160)}` });
    }
    await store.patch(section, parsed.data as never);
    await apply();
    return view();
  });

  app.delete<{ Params: { section: string } }>('/api/integrations/:section', async (req, reply) => {
    const section = req.params.section as 'google' | 'meta' | 'elevenlabs' | 'openai' | 'notion';
    if (!['google', 'meta', 'elevenlabs', 'openai', 'notion'].includes(section)) return reply.code(404).send({ error: 'unknown section' });
    await store.clear(section);
    if (section === 'notion') await s.settings.update({ notion: undefined, notionContextPages: [] });
    await apply();
    return view();
  });

  // ---------- Google: which calendar each account reads, read-only switch ----------

  app.get<{ Params: { account: string } }>('/api/integrations/google/calendars/:account', async (req, reply) => {
    const account = req.params.account;
    if (account !== 'work' && account !== 'personal') return reply.code(404).send({ error: 'unknown account' });
    if (!s.calendar?.calendars) return reply.code(400).send({ error: 'Спершу підключіть Google' });
    try {
      return { items: await s.calendar.calendars(account) };
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e).slice(0, 300) });
    }
  });

  const googleBody = z.object({
    readOnly: z.boolean().optional(),
    calendars: z.object({ work: z.string().trim().min(1).max(300).optional(), personal: z.string().trim().min(1).max(300).optional() }).optional(),
  });
  app.patch('/api/integrations/google', async (req, reply) => {
    const parsed = googleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    const cur = (await store.get()).google ?? {};
    const { readOnly, calendars } = parsed.data;
    await store.patch('google', { ...(readOnly !== undefined ? { readOnly } : {}), ...(calendars ? { calendars: { ...cur.calendars, ...calendars } } : {}) });
    await apply();
    return view();
  });

  // ---------- Notion wizard (read-only by default) ----------

  app.post<{ Body: { token?: string } }>('/api/integrations/notion/token', async (req, reply) => {
    const token = String(req.body?.token ?? '').trim();
    if (!/^(ntn_|secret_)\w{20,}/.test(token)) return reply.code(400).send({ error: 'Це не схоже на токен інтеграції Notion (починається з ntn_ або secret_)' });
    try {
      const me = await new NotionHttp(token, s.cfg.NOTION_VERSION).request<any>('GET', '/v1/users/me');
      const cur = (await store.get()).notion;
      await store.patch('notion', { token, readOnly: cur?.readOnly ?? true });
      await apply();
      return { ok: true, bot: me.name, workspace: me.bot?.workspace_name, view: await view() };
    } catch (e) {
      return reply.code(400).send({ error: `Notion не прийняв токен: ${errMsg(e).slice(0, 160)}` });
    }
  });

  /** what the integration can see (pages and databases the owner shared with it) */
  app.get('/api/integrations/notion/browse', async (_req, reply) => {
    if (!s.notionApi) return reply.code(400).send({ error: 'Спершу додайте токен Notion' });
    const out: Array<{ id: string; type: 'database' | 'page'; title: string; url?: string }> = [];
    for (const value of ['database', 'page'] as const) {
      const res = await s.notionApi.request<any>('POST', '/v1/search', { filter: { property: 'object', value }, page_size: 50 });
      for (const r of res.results ?? []) {
        const t = value === 'database' ? title(r.title) : title(Object.values<any>(r.properties ?? {}).find((p) => p.type === 'title')?.title);
        out.push({ id: r.id, type: value, title: t, url: r.url });
      }
    }
    return { items: out };
  });

  /** Read-only setup: map the existing tasks database, pick pages read into the prompt. Creates nothing in Notion. */
  app.post<{ Body: { tasksDb?: string; contextPages?: string[]; importProjects?: boolean; projects?: string[] } }>('/api/integrations/notion/configure', async (req, reply) => {
    if (!s.notionApi) return reply.code(400).send({ error: 'Спершу додайте токен Notion' });
    const tasksDb = String(req.body?.tasksDb ?? '').trim();
    const contextPages = (req.body?.contextPages ?? []).map(String).slice(0, 5);
    try {
      const meta = await s.notionApi.request<NotionDatabaseMeta>('GET', `/v1/databases/${tasksDb}`);
      const tasks = discoverTasksSchema(meta);
      const st = await s.settings.get();
      const repo = new NotionRepo(s.notionApi, { tasks });
      const given = (req.body?.projects ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 30);
      let projects = given;
      if (!projects.length && req.body?.importProjects !== false) {
        projects = projectOptions(meta, tasks.project);
        // no project property: the client's projects are the title prefixes («MLI · …») of existing tasks
        if (!projects.length && tasks.projectFromTitle) projects = [...new Set((await repo.queryTasks({ limit: 100 })).map((t) => t.project).filter((p): p is string => !!p))];
      }
      await s.settings.update({
        notion: { ...st.notion, tasks },
        notionContextPages: contextPages,
        ...(projects.length && (given.length || !st.projects.length) ? { projects } : {}),
      });
      await store.patch('notion', { tasksDb, contextPages });
      await apply();
      const sample = await repo.queryTasks({ open: true, limit: 5 });
      return { mapping: tasks, projects: projects.length ? projects : st.projects, sample, view: await view() };
    } catch (e) {
      return reply.code(400).send({ error: errMsg(e).slice(0, 300) });
    }
  });

  app.patch<{ Body: { readOnly?: boolean } }>('/api/integrations/notion', async (req, reply) => {
    if (typeof req.body?.readOnly !== 'boolean') return reply.code(400).send({ error: 'readOnly: true | false' });
    await store.patch('notion', { readOnly: req.body.readOnly });
    return view();
  });

  // ---------- custom integrations ----------

  const webhookBody = z.object({
    id: z.string().optional(),
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().min(5).max(500),
    url: httpsUrl(dev),
    secret: z.string().max(200).optional(),
    params: z.array(z.object({ name: z.string().trim().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/, 'назва параметра латиницею'), description: z.string().trim().max(200), required: z.boolean() })).max(12),
    enabled: z.boolean().default(true),
  });

  app.post('/api/integrations/custom/webhook', async (req, reply) => {
    const parsed = webhookBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    await store.upsertCustom({ type: 'webhook', ...parsed.data, secret: parsed.data.secret || undefined });
    return view();
  });

  const mcpBody = z.object({ id: z.string().optional(), name: z.string().trim().min(2).max(40), url: httpsUrl(dev), authorization: z.string().max(500).optional() });

  /** Add or refresh an MCP server: lists its tools; new tools start enabled and confirmed (the owner relaxes reads). */
  app.post('/api/integrations/custom/mcp', async (req, reply) => {
    const parsed = mcpBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const prev = (await store.get()).custom?.find((c) => c.id === parsed.data.id);
    const auth = parsed.data.authorization || (prev?.type === 'mcp' ? prev.authorization : undefined);
    try {
      const listed = await mcpListTools(parsed.data.url, auth);
      const old = new Map(prev?.type === 'mcp' ? prev.tools.map((t) => [t.name, t]) : []);
      const tools = listed.slice(0, 40).map((t) => ({ ...t, enabled: old.get(t.name)?.enabled ?? true, confirm: old.get(t.name)?.confirm ?? true }));
      await store.upsertCustom({ type: 'mcp', id: parsed.data.id, name: parsed.data.name, url: parsed.data.url, authorization: auth, tools, enabled: prev?.enabled ?? true });
      return view();
    } catch (e) {
      return reply.code(400).send({ error: `Не вдалося підключитися до MCP: ${errMsg(e).slice(0, 200)}` });
    }
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; tools?: Array<{ name: string; enabled?: boolean; confirm?: boolean }> } }>('/api/integrations/custom/:id', async (req, reply) => {
    const cur = (await store.get()).custom?.find((c) => c.id === req.params.id);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const next = { ...cur, ...(typeof req.body?.enabled === 'boolean' ? { enabled: req.body.enabled } : {}) } as CustomIntegration;
    if (next.type === 'mcp' && req.body?.tools) {
      const patch = new Map(req.body.tools.map((t) => [t.name, t]));
      next.tools = next.tools.map((t) => ({ ...t, enabled: patch.get(t.name)?.enabled ?? t.enabled, confirm: patch.get(t.name)?.confirm ?? t.confirm }));
    }
    await store.upsertCustom(next);
    return view();
  });

  app.delete<{ Params: { id: string } }>('/api/integrations/custom/:id', async (req) => {
    await store.removeCustom(req.params.id);
    return view();
  });
}
