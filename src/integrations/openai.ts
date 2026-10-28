import { http, httpJson } from '../lib/http.js';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  /** `raw`: provider output items (reasoning + calls) to hand back verbatim on the next step */
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; raw?: unknown[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  raw?: unknown[];
}

/** Everything the system needs from a language model: swapped for a fake in tests. */
export interface ChatArgs {
  messages: LlmMessage[];
  tools?: ToolSpec[];
  json?: boolean;
  temperature?: number;
  /** override the default chat model (voice uses a faster one) */
  model?: string;
  maxTokens?: number;
  /** stream the answer: called with each text fragment as it is generated */
  onText?: (delta: string) => void;
}

export interface Llm {
  chat(args: ChatArgs): Promise<ChatResult>;
  /** `prompt` biases recognition (names, short answers like «так») */
  transcribe(audio: Uint8Array, filename: string, mime: string, language?: string, prompt?: string, model?: string): Promise<string>;
  webSearch(prompt: string): Promise<string>;
}

const BASE = 'https://api.openai.com/v1';

export class OpenAi implements Llm {
  constructor(
    private apiKey: string,
    private models: { chat: string; transcribe: string; search: string },
    /** reasoning effort for models that think (gpt-5.x, gpt-6.x, o-series) */
    private reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' = 'low',
  ) {}

  /** Newer models do tools + reasoning only through the Responses API. */
  static usesResponses(model: string): boolean {
    return /^(gpt-5|gpt-6|o\d)/.test(model);
  }

  private get headers() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    const model = args.model ?? this.models.chat;
    if (OpenAi.usesResponses(model)) return this.respond(model, args);
    const messages = args.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant')
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
            : {}),
        };
      return m;
    });
    const body = {
      model,
      messages,
      temperature: args.temperature ?? 0.2,
      ...(args.maxTokens ? { max_tokens: args.maxTokens } : {}),
      ...(args.tools?.length
        ? { tools: args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
      ...(args.json ? { response_format: { type: 'json_object' } } : {}),
    };
    if (args.onText) return this.chatStream(body, args.onText);
    const res = await httpJson<any>(`${BASE}/chat/completions`, { method: 'POST', headers: this.headers, json: body, timeoutMs: 90_000 });
    const msg = res.choices?.[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    };
  }

  /**
   * Responses API (stateless: store=false). Reasoning items come back encrypted and are passed back on the
   * next step together with the function calls, so the model keeps its chain of thought across tool rounds.
   */
  private async respond(model: string, args: ChatArgs): Promise<ChatResult> {
    const instructions = args.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const input: unknown[] = [];
    for (const m of args.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') input.push({ role: 'user', content: m.content });
      else if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      else if (m.role !== 'assistant') continue;
      else if (m.raw?.length) input.push(...m.raw);
      else {
        if (m.content) input.push({ role: 'assistant', content: m.content });
        for (const c of m.toolCalls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
      }
    }
    const body = {
      model,
      instructions,
      input,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: this.reasoningEffort },
      ...(args.maxTokens ? { max_output_tokens: Math.max(args.maxTokens, 800) } : {}),
      ...(args.tools?.length ? { tools: args.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
      ...(args.json ? { text: { format: { type: 'json_object' } } } : {}),
    };
    let output: any[];
    if (args.onText) output = await this.respondStream(body, args.onText);
    else output = (await httpJson<any>(`${BASE}/responses`, { method: 'POST', headers: this.headers, json: body, timeoutMs: 120_000 })).output ?? [];
    const toolCalls = output.filter((o) => o.type === 'function_call').map((c) => ({ id: c.call_id, name: c.name, arguments: c.arguments ?? '{}' }));
    const content = output
      .filter((o) => o.type === 'message')
      .flatMap((o) => (o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
      .join('');
    // keep only what the next step needs: reasoning + calls (ids dropped: nothing is stored server-side)
    const raw = toolCalls.length
      ? output.filter((o) => o.type === 'reasoning' || o.type === 'function_call').map(({ id: _id, status: _st, ...rest }) => rest)
      : undefined;
    return { content: content || null, toolCalls, raw };
  }

  private async respondStream(body: Record<string, unknown>, onText: (delta: string) => void): Promise<any[]> {
    const res = await http(`${BASE}/responses`, { method: 'POST', headers: this.headers, json: { ...body, stream: true }, timeoutMs: 120_000 });
    if (!res.body) throw new Error('OpenAI: empty stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let output: any[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'response.output_text.delta' && ev.delta) onText(ev.delta);
        else if (ev.type === 'response.completed') output = ev.response?.output ?? [];
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(`OpenAI: ${ev.response?.error?.message ?? ev.message ?? 'stream failed'}`);
      }
    }
    return output;
  }

  /** SSE streaming: text fragments go to `onText` immediately, tool calls are assembled from their deltas. */
  private async chatStream(body: Record<string, unknown>, onText: (delta: string) => void): Promise<ChatResult> {
    const res = await http(`${BASE}/chat/completions`, { method: 'POST', headers: this.headers, json: { ...body, stream: true }, timeoutMs: 90_000 });
    if (!res.body) throw new Error('OpenAI: empty stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const delta = JSON.parse(data).choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: '', name: '', arguments: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.arguments += tc.function.arguments;
        }
      }
    }
    return { content: content || null, toolCalls: calls.filter(Boolean) };
  }

  async transcribe(audio: Uint8Array, filename: string, mime: string, language?: string, prompt?: string, model?: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as ArrayBuffer], { type: mime }), filename);
    form.append('model', model ?? this.models.transcribe);
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    const res = await httpJson<{ text: string }>(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: this.headers,
      body: form,
      timeoutMs: 120_000,
    });
    return res.text.trim();
  }

  /** Responses API with the built-in web search tool. Returns the model's text answer. */
  async webSearch(prompt: string): Promise<string> {
    const res = await httpJson<any>(`${BASE}/responses`, {
      method: 'POST',
      headers: this.headers,
      json: { model: this.models.search, tools: [{ type: 'web_search' }], input: prompt },
      timeoutMs: 180_000,
    });
    const texts: string[] = [];
    for (const item of res.output ?? []) {
      if (item.type !== 'message') continue;
      for (const c of item.content ?? []) if (c.type === 'output_text') texts.push(c.text);
    }
    return texts.join('\n').trim();
  }
}

export interface RealtimeSecret {
  value: string;
  expiresAt: number;
}

/** Short-lived key the browser uses to open a WebRTC voice session directly with OpenAI (the real key never leaves the server). */
export async function createRealtimeSecret(apiKey: string, session: Record<string, unknown>): Promise<RealtimeSecret> {
  const res = await httpJson<{ value: string; expires_at: number }>(`${BASE}/realtime/client_secrets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    json: { expires_after: { anchor: 'created_at', seconds: 600 }, session },
    retries: 1,
  });
  return { value: res.value, expiresAt: res.expires_at };
}
