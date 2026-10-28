import { http } from '../lib/http.js';

/** Minimal MCP client over Streamable HTTP: initialize → tools/list or tools/call (one short session per use). */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PROTOCOL = '2025-06-18';

async function rpc(url: string, auth: string | undefined, session: string | undefined, msg: Record<string, unknown>) {
  const res = await http(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: auth } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
      'mcp-protocol-version': PROTOCOL,
    },
    json: msg,
    retries: 0,
    timeoutMs: 60_000,
  });
  const sessionId = res.headers.get('mcp-session-id') ?? session;
  const text = await res.text();
  if (!('id' in msg)) return { sessionId, result: undefined };
  // JSON or an SSE stream of JSON-RPC messages: take the response carrying our id
  const bodies = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    : [text];
  for (const b of bodies) {
    if (!b) continue;
    const m = JSON.parse(b);
    if (m.id !== msg.id) continue;
    if (m.error) throw new Error(`MCP: ${m.error.message ?? JSON.stringify(m.error)}`);
    return { sessionId, result: m.result };
  }
  throw new Error('MCP: no response');
}

async function open(url: string, auth?: string): Promise<string | undefined> {
  const init = await rpc(url, auth, undefined, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'personal-ai-assistant', version: '1.0' } },
  });
  await rpc(url, auth, init.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return init.sessionId;
}

export async function mcpListTools(url: string, auth?: string): Promise<McpToolInfo[]> {
  const session = await open(url, auth);
  const { result } = await rpc(url, auth, session, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  return (result?.tools ?? []).map((t: any) => ({
    name: String(t.name),
    description: String(t.description ?? '').slice(0, 900),
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  }));
}

export async function mcpCallTool(url: string, auth: string | undefined, name: string, args: Record<string, unknown>): Promise<string> {
  const session = await open(url, auth);
  const { result } = await rpc(url, auth, session, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
  const text = (result?.content ?? [])
    .map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? '') : `[${c.type}]`))
    .join('\n')
    .slice(0, 8000);
  if (result?.isError) throw new Error(text || 'MCP tool error');
  return text || 'ok';
}

/** Webhook action (Make / Zapier / n8n): POST JSON, return a short reply text. */
export async function callWebhook(url: string, secret: string | undefined, action: string, params: Record<string, unknown>): Promise<string> {
  const res = await http(url, {
    method: 'POST',
    headers: secret ? { 'x-assistant-secret': secret } : {},
    json: { action, params, sentAt: new Date().toISOString() },
    retries: 0,
    timeoutMs: 30_000,
  });
  const text = (await res.text()).trim();
  return text ? text.slice(0, 2000) : `HTTP ${res.status}`;
}
