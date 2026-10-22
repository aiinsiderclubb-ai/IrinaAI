import { httpJson } from '../lib/http.js';

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
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
}

/** Everything the system needs from a language model: swapped for a fake in tests. */
export interface Llm {
  chat(args: { messages: LlmMessage[]; tools?: ToolSpec[]; json?: boolean; temperature?: number }): Promise<ChatResult>;
  transcribe(audio: Uint8Array, filename: string, mime: string, language?: string): Promise<string>;
  webSearch(prompt: string): Promise<string>;
}

const BASE = 'https://api.openai.com/v1';

export class OpenAi implements Llm {
  constructor(
    private apiKey: string,
    private models: { chat: string; transcribe: string; search: string },
  ) {}

  private get headers() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async chat(args: { messages: LlmMessage[]; tools?: ToolSpec[]; json?: boolean; temperature?: number }): Promise<ChatResult> {
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
    const res = await httpJson<any>(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      json: {
        model: this.models.chat,
        messages,
        temperature: args.temperature ?? 0.2,
        ...(args.tools?.length
          ? { tools: args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
        ...(args.json ? { response_format: { type: 'json_object' } } : {}),
      },
      timeoutMs: 90_000,
    });
    const msg = res.choices?.[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    };
  }

  async transcribe(audio: Uint8Array, filename: string, mime: string, language?: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as ArrayBuffer], { type: mime }), filename);
    form.append('model', this.models.transcribe);
    if (language) form.append('language', language);
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
