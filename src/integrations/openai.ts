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
  /** override the reasoning effort (live voice thinks less to answer sooner) */
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** stream the answer: called with each text fragment as it is generated */
  onText?: (delta: string) => void;
}

/** Token usage per model, accumulated by the client (for the eval report and cost estimates). */
export interface UsageRow {
  calls: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  ms: number;
}

export interface Llm {
  chat(args: ChatArgs): Promise<ChatResult>;
  /** `prompt` biases recognition (names, short answers like «так») */
  transcribe(audio: Uint8Array, filename: string, mime: string, language?: string, prompt?: string, model?: string): Promise<string>;
  webSearch(prompt: string): Promise<WebAnswer>;
  /** vectors for search by meaning (absent: keyword search only) */
  embed?(texts: string[]): Promise<number[][]>;
  /** reads an image or a PDF (scans) and answers `prompt` about it */
  see?(file: { data: Uint8Array; mime: string; name: string }, prompt: string): Promise<string>;
}

/** what a web search returns: the model's answer and the pages it cited */
export interface WebAnswer {
  text: string;
  sources: Array<{ title: string; url: string }>;
}

const BASE = 'https://api.openai.com/v1';
/** embedding size: text-embedding-3-small shortened to 512 numbers is plenty for project materials */
export const EMBED_DIMS = 512;

/** OpenAI tags cited links with ?utm_source=openai; the owner gets the plain link */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.delete('utm_source');
    return u.toString();
  } catch {
    return raw;
  }
}

export class OpenAi implements Llm {
  constructor(
    private apiKey: string,
    private models: { chat: string; transcribe: string; search: string; embed?: string },
    /** reasoning effort for models that think (gpt-5.x, gpt-6.x, o-series) */
    private reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' = 'low',
  ) {}

  readonly usage = new Map<string, UsageRow>();

  private track(model: string, u: any, ms: number): void {
    const row = this.usage.get(model) ?? { calls: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0, ms: 0 };
    row.calls++;
    row.ms += ms;
    if (u) {
      row.input += u.input_tokens ?? u.prompt_tokens ?? 0;
      row.cachedInput += u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      row.output += u.output_tokens ?? u.completion_tokens ?? 0;
      row.reasoning += u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0;
    }
    this.usage.set(model, row);
  }

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
    const t0 = Date.now();
    if (args.onText) {
      const r = await this.chatStream(body, args.onText);
      this.track(model, r.usage, Date.now() - t0);
      return r;
    }
    const res = await httpJson<any>(`${BASE}/chat/completions`, { method: 'POST', headers: this.headers, json: body, timeoutMs: 90_000 });
    this.track(model, res.usage, Date.now() - t0);
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
      reasoning: { effort: args.effort ?? this.reasoningEffort },
      ...(args.maxTokens ? { max_output_tokens: Math.max(args.maxTokens, 800) } : {}),
      ...(args.tools?.length ? { tools: args.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
      ...(args.json ? { text: { format: { type: 'json_object' } } } : {}),
    };
    const t0 = Date.now();
    let output: any[];
    let usage: unknown;
    if (args.onText) ({ output, usage } = await this.respondStream(body, args.onText));
    else {
      const r = await httpJson<any>(`${BASE}/responses`, { method: 'POST', headers: this.headers, json: body, timeoutMs: 120_000 });
      output = r.output ?? [];
      usage = r.usage;
    }
    this.track(model, usage, Date.now() - t0);
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

  private async respondStream(body: Record<string, unknown>, onText: (delta: string) => void): Promise<{ output: any[]; usage: unknown }> {
    const res = await http(`${BASE}/responses`, { method: 'POST', headers: this.headers, json: { ...body, stream: true }, timeoutMs: 120_000 });
    if (!res.body) throw new Error('OpenAI: empty stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let output: any[] = [];
    let usage: unknown;
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
        else if (ev.type === 'response.completed') {
          output = ev.response?.output ?? [];
          usage = ev.response?.usage;
        }
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(`OpenAI: ${ev.response?.error?.message ?? ev.message ?? 'stream failed'}`);
      }
    }
    return { output, usage };
  }

  /** SSE streaming: text fragments go to `onText` immediately, tool calls are assembled from their deltas. */
  private async chatStream(body: Record<string, unknown>, onText: (delta: string) => void): Promise<ChatResult & { usage?: unknown }> {
    const res = await http(`${BASE}/chat/completions`, { method: 'POST', headers: this.headers, json: { ...body, stream: true, stream_options: { include_usage: true } }, timeoutMs: 90_000 });
    let usage: unknown;
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
        const parsed = JSON.parse(data);
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta;
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
    return { content: content || null, toolCalls: calls.filter(Boolean), usage };
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

  async embed(texts: string[]): Promise<number[][]> {
    const model = this.models.embed ?? 'text-embedding-3-small';
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const t0 = Date.now();
      const res = await httpJson<any>(`${BASE}/embeddings`, {
        method: 'POST',
        headers: this.headers,
        json: { model, input: texts.slice(i, i + 96).map((t) => t.slice(0, 24_000) || ' '), dimensions: EMBED_DIMS },
        timeoutMs: 60_000,
      });
      this.track(model, res.usage, Date.now() - t0);
      for (const d of [...(res.data ?? [])].sort((a: any, b: any) => a.index - b.index)) out.push(d.embedding);
    }
    return out;
  }

  /** Vision: an image or a PDF goes to the chat model with a question about it. */
  async see(file: { data: Uint8Array; mime: string; name: string }, prompt: string): Promise<string> {
    const b64 = Buffer.from(file.data).toString('base64');
    const part = file.mime.startsWith('image/')
      ? { type: 'input_image', image_url: `data:${file.mime};base64,${b64}` }
      : { type: 'input_file', filename: file.name, file_data: `data:${file.mime};base64,${b64}` };
    const model = this.models.chat;
    const t0 = Date.now();
    const res = await httpJson<any>(`${BASE}/responses`, {
      method: 'POST',
      headers: this.headers,
      json: { model, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, part] }] },
      timeoutMs: 180_000,
    });
    this.track(model, res.usage, Date.now() - t0);
    return (res.output ?? [])
      .filter((o: any) => o.type === 'message')
      .flatMap((o: any) => (o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
      .join('')
      .trim();
  }

  /** Responses API with the built-in web search tool. Returns the model's text answer. */
  async webSearch(prompt: string): Promise<WebAnswer> {
    const t0 = Date.now();
    const res = await httpJson<any>(`${BASE}/responses`, {
      method: 'POST',
      headers: this.headers,
      json: { model: this.models.search, tools: [{ type: 'web_search' }], input: prompt },
      timeoutMs: 180_000,
    });
    this.track(this.models.search, res.usage, Date.now() - t0);
    const texts: string[] = [];
    const sources = new Map<string, string>();
    for (const item of res.output ?? []) {
      if (item.type !== 'message') continue;
      for (const c of item.content ?? []) {
        if (c.type !== 'output_text') continue;
        texts.push(c.text.replace(/([?&])utm_source=openai(&?)/g, (_m: string, p: string, n: string) => (n ? p : '')));
        for (const a of c.annotations ?? []) {
          if (a.type !== 'url_citation' || !a.url) continue;
          const url = cleanUrl(a.url);
          if (!sources.has(url)) sources.set(url, a.title || url);
        }
      }
    }
    return { text: texts.join('\n').trim(), sources: [...sources].map(([url, title]) => ({ title, url })) };
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
