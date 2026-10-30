import { afterEach, describe, expect, it } from 'vitest';
import { runPending } from '../src/actions.js';
import { Agent } from '../src/agent/agent.js';
import { applyIntegrations } from '../src/integrations/runtime.js';
import { GoogleCalendar } from '../src/integrations/google-calendar.js';
import { buildServer } from '../src/server.js';
import { IntegrationStore } from '../src/store/integrations.js';
import { registerWeb } from '../src/web/api.js';
import { issueSession, SESSION_COOKIE } from '../src/web/auth.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

/** Routes fetch by URL substring; records every call. */
function mockFetch(routes: Array<[match: string, reply: (body: any, init: RequestInit) => unknown]>) {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? 'GET', body, headers: (init.headers ?? {}) as Record<string, string> });
    const route = routes.find(([m]) => url.includes(m));
    if (!route) return new Response('not mocked: ' + url, { status: 599 });
    const out = route[1](body, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never;
  return calls;
}

async function setup() {
  const env = await makeEnv();
  env.s.integrations = new IntegrationStore(env.db, env.s.cfg.ENCRYPTION_KEY);
  const app = buildServer(env.s, {} as never);
  await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false });
  const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, 42, env.s.clock().getTime())}`;
  const H = { 'x-requested-with': 'aia', cookie };
  return { env, app, H };
}

describe('integration settings store', () => {
  it('encrypts secrets at rest, keeps them on empty form values, masks them in the API', async () => {
    const { env, app, H } = await setup();
    const res = await app.inject({ method: 'PUT', url: '/api/integrations/google', headers: H, payload: { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'GOCSPX-supersecret' } });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.google.configured).toBe(true);
    expect(v.google.clientSecret).toBe('•••• cret');
    expect(JSON.stringify(v)).not.toContain('supersecret');
    expect(v.google.accounts.work.connectUrl).toContain('accounts.google.com');
    const raw = JSON.stringify((await env.db.query("SELECT value FROM kv WHERE key = 'integrations'")).rows[0]);
    expect(raw).not.toContain('supersecret');
    await app.inject({ method: 'PUT', url: '/api/integrations/google', headers: H, payload: { clientId: 'client-456.apps.googleusercontent.com', clientSecret: '' } });
    expect((await env.s.integrations!.get()).google).toEqual({ clientId: 'client-456.apps.googleusercontent.com', clientSecret: 'GOCSPX-supersecret' });
    expect((await app.inject({ method: 'DELETE', url: '/api/integrations/google', headers: H })).json().google.configured).toBe(false);
  });

  it('rejects a key the provider does not accept', async () => {
    const { app, H } = await setup();
    mockFetch([['elevenlabs.io', () => new Response('{"detail":"invalid_api_key"}', { status: 401 })]]);
    const r = await app.inject({ method: 'PUT', url: '/api/integrations/elevenlabs', headers: H, payload: { apiKey: 'sk_wrongwrongwrong' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('Ключ не підійшов');
  });
});

describe('Notion wizard', () => {
  it('token → browse → configure maps the existing tasks DB read-only; writes stay blocked until enabled', async () => {
    const { env, app, H } = await setup();
    await env.s.settings.update({ notion: undefined, projects: [] }); // a fresh client: nothing mapped yet
    const calls = mockFetch([
      ['/v1/users/me', () => ({ name: 'AI Assistant', bot: { workspace_name: 'Irina Gromova' } })],
      ['/v1/search', (b) => ({ results: b.filter.value === 'database' ? [{ id: 'db-tasks', title: [{ plain_text: 'MLI · Завдання' }], url: 'u' }] : [{ id: 'pg-hq', properties: { t: { type: 'title', title: [{ plain_text: 'Управлінський центр' }] } } }], has_more: false })],
      ['/v1/databases/db-tasks/query', () => ({ results: [{ id: 't1', url: 'u', properties: { Задача: { title: [{ plain_text: 'Стратегія MLI' }] }, Статус: { status: { name: 'В роботі' } } } }], has_more: false })],
      ['/v1/databases/db-tasks', () => ({ id: 'db-tasks', properties: { Задача: { id: 'a', type: 'title' }, Статус: { id: 'b', type: 'status', status: { options: [{ name: 'Не розпочато' }, { name: 'В роботі' }, { name: 'Завершено' }] } }, Напрям: { id: 'c', type: 'select', select: { options: [{ name: 'MLI' }, { name: 'Мистецтво Жити' }] } } } })],
    ]);
    const t = await app.inject({ method: 'POST', url: '/api/integrations/notion/token', headers: H, payload: { token: 'ntn_abcdefghijklmnopqrstuvwxyz123456' } });
    expect(t.json()).toMatchObject({ ok: true, workspace: 'Irina Gromova' });
    expect(t.json().view.notion).toMatchObject({ readOnly: true, state: 'setup' });
    const b = (await app.inject({ url: '/api/integrations/notion/browse', headers: H })).json();
    expect(b.items.map((i: any) => i.title)).toEqual(['MLI · Завдання', 'Управлінський центр']);
    const c = await app.inject({ method: 'POST', url: '/api/integrations/notion/configure', headers: { ...H }, payload: { tasksDb: 'db-tasks', contextPages: ['pg-hq'] } });
    expect(c.statusCode).toBe(200);
    expect(c.json().mapping.status).toMatchObject({ todo: 'Не розпочато', done: 'Завершено' });
    expect(c.json().sample[0]).toMatchObject({ title: 'Стратегія MLI', status: 'В роботі' });
    expect((await env.s.settings.get()).notionContextPages).toEqual(['pg-hq']);
    // nothing was written: only reads (GET, and POST for search/query which are read endpoints in Notion's API)
    expect(calls.filter((x) => x.url.includes('api.notion.com')).every((x) => x.method === 'GET' || /\/search|\/query/.test(x.url))).toBe(true);

    // the agent may not prepare Notion writes while read-only
    env.llm.script.push(toolCall('task_create', { title: 'Нова задача' }), (m) => {
      expect(JSON.stringify(m.at(-1))).toContain('read_only');
      return say('Notion поки лише на читання.');
    });
    const reply = await new Agent(env.s).handle(42, 'додай задачу');
    expect(reply.proposals).toHaveLength(0);

    await app.inject({ method: 'PATCH', url: '/api/integrations/notion', headers: H, payload: { readOnly: false } });
    expect((await env.s.integrations!.get()).notion?.readOnly).toBe(false);
  });
});

describe('Google calendar: shared calendars, read-only', () => {
  it('reads the chosen (shared) calendar instead of primary', async () => {
    const urls: string[] = [];
    const auth = { authedJson: async (_slot: string, url: string) => (urls.push(url), url.includes('calendarList') ? { items: [{ id: 'irina@gmail.com', summary: 'Ірина', accessRole: 'reader' }, { id: 'me@gmail.com', summary: 'me', primary: true, accessRole: 'owner' }] } : { items: [] }) };
    const cal = new GoogleCalendar(auth as never, (a) => (a === 'work' ? 'irina@gmail.com' : 'primary'));
    await cal.list('work', '2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z');
    await cal.list('personal', '2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z');
    expect(urls[0]).toContain('/calendars/irina%40gmail.com/events');
    expect(urls[1]).toContain('/calendars/primary/events');
    expect(await cal.calendars('work')).toEqual([
      { id: 'irina@gmail.com', name: 'Ірина', primary: false, access: 'reader' },
      { id: 'me@gmail.com', name: 'me', primary: true, access: 'owner' },
    ]);
  });

  it('once Google is set up from the cabinet, the agent may not create events until writes are allowed', async () => {
    const { env, app, H } = await setup();
    await env.s.integrations!.patch('google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec' });
    env.llm.script.push(toolCall('calendar_create', { title: 'Зустріч', start: `${env.s.clock().toISOString().slice(0, 10)}T15:00`, end: `${env.s.clock().toISOString().slice(0, 10)}T16:00` }), (m) => {
      expect(JSON.stringify(m.at(-1))).toContain('read_only');
      return say('Календар поки лише на читання.');
    });
    expect((await new Agent(env.s).handle(42, 'постав зустріч о 15')).proposals).toHaveLength(0);

    const v = (await app.inject({ method: 'PATCH', url: '/api/integrations/google', headers: H, payload: { calendars: { work: 'irina@gmail.com' } } })).json();
    expect(v.google).toMatchObject({ readOnly: true, calendars: { work: 'irina@gmail.com', personal: 'primary' } });
    await app.inject({ method: 'PATCH', url: '/api/integrations/google', headers: H, payload: { readOnly: false } });
    expect((await env.s.integrations!.get()).google).toMatchObject({ readOnly: false, calendars: { work: 'irina@gmail.com' }, clientSecret: 'sec' });
  });
});

describe('custom integrations', () => {
  it('webhook action: becomes a tool, proposes a card, posts JSON with the secret only after confirmation', async () => {
    const { env, app, H } = await setup();
    const add = await app.inject({
      method: 'POST',
      url: '/api/integrations/custom/webhook',
      headers: H,
      payload: { name: 'Send email', description: 'Надіслати email від імені власника', url: 'https://hook.eu2.make.com/abc', secret: 's3cret', params: [{ name: 'to', description: 'кому', required: true }, { name: 'text', description: 'текст', required: true }] },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().custom[0]).toMatchObject({ type: 'webhook', name: 'Send email', secret: '•••• cret' });
    expect((await app.inject({ method: 'POST', url: '/api/integrations/custom/webhook', headers: H, payload: { name: 'x', description: 'xxxxx', url: 'http://evil.example', params: [] } })).statusCode).toBe(400);

    let specs: string[] = [];
    env.llm.script.push((m) => {
      specs = (env.llm.calls.at(-1)!.tools ?? []).map((t) => t.name);
      return toolCall('ext_send_email', { to: 'olena@mli.com', text: 'NDA підписано' });
    }, say('Підготувала лист.'));
    const r = await new Agent(env.s).handle(42, 'напиши Олені, що NDA підписано');
    expect(specs).toContain('ext_send_email');
    expect(r.proposals[0]).toMatchObject({ kind: 'custom.webhook' });

    const calls = mockFetch([['hook.eu2.make.com', () => new Response('Accepted', { status: 200 })]]);
    const done = await runPending(env.s, r.proposals[0]!.id);
    expect(done.ok).toBe(true);
    expect(calls[0]!.body).toMatchObject({ action: 'Send email', params: { to: 'olena@mli.com', text: 'NDA підписано' } });
    expect(calls[0]!.headers['x-assistant-secret']).toBe('s3cret');
  });

  it('MCP server: tools listed on connect, read tools run directly, confirmed tools become cards', async () => {
    const { env, app, H } = await setup();
    const rpc = (body: any) => {
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (body.method === 'tools/list')
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [
          { name: 'search_emails', description: 'Search mail', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          { name: 'send_email', description: 'Send mail', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
        ] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      if (body.method === 'tools/call') return { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `called ${body.params.name} ${JSON.stringify(body.params.arguments)}` }] } };
      return new Response('?', { status: 400 });
    };
    const calls = mockFetch([['mcp.example.com', rpc]]);
    const add = await app.inject({ method: 'POST', url: '/api/integrations/custom/mcp', headers: H, payload: { name: 'Gmail', url: 'https://mcp.example.com/mcp', authorization: 'Bearer tok' } });
    expect(add.statusCode).toBe(200);
    const mcp = add.json().custom[0];
    expect(mcp.tools.map((t: any) => [t.name, t.enabled, t.confirm])).toEqual([['search_emails', true, true], ['send_email', true, true]]);
    expect(calls.find((c) => c.body?.method === 'tools/list')!.headers['mcp-session-id']).toBe('sess-1');
    // the owner relaxes the read tool
    await app.inject({ method: 'PATCH', url: `/api/integrations/custom/${mcp.id}`, headers: H, payload: { tools: [{ name: 'search_emails', confirm: false }] } });

    env.llm.script.push(toolCall('mcp_gmail_search_emails', { q: 'NDA' }, 'c1'), toolCall('mcp_gmail_send_email', { to: 'olena@mli.com' }, 'c2'), say('Знайшла лист і підготувала відповідь.'));
    const r = await new Agent(env.s).handle(42, 'знайди лист про NDA і відпиши Олені');
    expect(calls.some((c) => c.body?.method === 'tools/call' && c.body.params.name === 'search_emails')).toBe(true);
    expect(calls.some((c) => c.body?.method === 'tools/call' && c.body.params.name === 'send_email')).toBe(false); // waits for the card
    expect(r.proposals.map((p) => p.kind)).toEqual(['custom.mcp']);
    const done = await runPending(env.s, r.proposals[0]!.id);
    expect(done.text).toContain('called send_email');
  });
});

describe('live reconfigure', () => {
  it('applying cabinet settings builds Google and ElevenLabs clients without a restart', async () => {
    const { env } = await setup();
    expect(env.s.googleAuth).toBeUndefined();
    await env.s.integrations!.patch('google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec' });
    await env.s.integrations!.patch('elevenlabs', { apiKey: 'sk_eleven_test_key' });
    await applyIntegrations(env.s);
    expect(env.s.googleAuth).toBeDefined();
    expect(env.s.calendar).toBeDefined();
    expect(env.s.tts?.constructor.name).toBe('ElevenLabs');
  });
});

describe('Instagram via Facebook Login (business portfolio access)', () => {
  it('builds the Facebook dialog, finds the account through the portfolio and reads stats from graph.facebook.com', async () => {
    const { env, app, H } = await setup();
    const res = await app.inject({ method: 'PUT', url: '/api/integrations/meta', headers: H, payload: { appId: '1234567890', appSecret: 'meta-secret-xyz' } });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.meta.login).toBe('facebook');
    const auth = new URL(v.meta.instagram.connectUrl);
    expect(auth.host).toBe('www.facebook.com');
    expect(auth.searchParams.get('scope')).toContain('instagram_manage_insights');

    const calls = mockFetch([
      ['/oauth/access_token', () => ({ access_token: calls.length === 1 ? 'SHORT' : 'LONG', expires_in: 5_184_000 })],
      ['/me/accounts', () => ({ data: [{ name: 'Page without IG', access_token: 'PAGE' }] })],
      ['/me/businesses', () => ({ data: [{ id: 'BIZ1', name: 'Ирина Громова' }] })],
      ['/BIZ1/instagram_business_accounts', () => ({ data: [{ id: '1784', username: 'irina.gromova' }] })],
      ['/BIZ1/', () => new Response('{"error":{"message":"no role"}}', { status: 403 })],
      ['/1784/insights', () => ({ data: [{ total_value: { value: 1200 } }] })],
      ['/1784/media', () => ({ data: [{ id: 'M1', caption: 'Пост\nдалі', permalink: 'https://instagram.com/p/1', timestamp: '2026-10-29T10:00:00Z', like_count: 40, comments_count: 3 }] })],
      ['/M1/insights', () => ({ data: [{ name: 'reach', values: [{ value: 900 }] }] })],
      ['/1784?', () => ({ username: 'irina.gromova', followers_count: 15000, follows_count: 300, media_count: 520 })],
    ]);
    await env.s.instagram!.exchangeCode('CODE');
    const t = await env.s.tokens.get('instagram');
    expect(t?.meta).toMatchObject({ login: 'facebook', userId: '1784', username: 'irina.gromova' });
    expect(t?.accessToken).toBe('LONG');
    expect(t?.expiresAt).toBeInstanceOf(Date);
    expect(calls.some((c) => c.url.includes('fb_exchange_token=SHORT'))).toBe(true);

    const snap = await env.s.instagram!.snapshot(7);
    expect(snap).toMatchObject({ account: 'irina.gromova', totals: { followers: 15000 }, period: { reach: 1200 } });
    expect(snap.posts[0]).toMatchObject({ title: 'Пост', metrics: { likes: 40, reach: 900 } });
    expect(calls.filter((c) => c.url.includes('graph.instagram.com'))).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/integrations', headers: H })).json().meta.instagram).toMatchObject({ state: 'on', username: 'irina.gromova' });
  });

  it('prefers a Page token, which does not expire', async () => {
    const { env, app, H } = await setup();
    await app.inject({ method: 'PUT', url: '/api/integrations/meta', headers: H, payload: { appId: '1234567890', appSecret: 'meta-secret-xyz', configId: '998877' } });
    expect(new URL((await app.inject({ method: 'GET', url: '/api/integrations', headers: H })).json().meta.instagram.connectUrl).searchParams.get('config_id')).toBe('998877');
    mockFetch([
      ['/oauth/access_token', () => ({ access_token: 'USER' })],
      ['/me/accounts', () => ({ data: [{ name: 'Ірина', access_token: 'PAGE-TOKEN', instagram_business_account: { id: '1784', username: 'irina.gromova' } }] })],
      ['/me/businesses', () => ({ data: [] })],
    ]);
    await env.s.instagram!.exchangeCode('CODE');
    const t = await env.s.tokens.get('instagram');
    expect(t?.accessToken).toBe('PAGE-TOKEN');
    expect(t?.expiresAt).toBeUndefined();
    expect(await env.s.instagram!.refreshToken(true)).toBeUndefined();
  });
});
