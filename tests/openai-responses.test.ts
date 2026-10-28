import { describe, expect, it } from 'vitest';
import { OpenAi } from '../src/integrations/openai.js';

describe('OpenAI Responses API path (gpt-5.x / gpt-6.x)', () => {
  it('routes new models to /responses, maps tools, returns calls and passes reasoning back on the next step', async () => {
    const bodies: any[] = [];
    const urls: string[] = [];
    const replies = [
      {
        output: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
          { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: 'tasks_list', arguments: '{"text":"юрист"}' },
        ],
      },
      { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Готово, знайшла.' }] }] },
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string, init: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never;
    try {
      const llm = new OpenAi('k', { chat: 'gpt-6.1-sol', transcribe: 't', search: 's' }, 'low');
      const tools = [{ name: 'tasks_list', description: 'd', parameters: { type: 'object', properties: {} } }];
      const first = await llm.chat({ messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'я відповів юристу' }], tools, temperature: 0.6 });
      expect(first.toolCalls).toEqual([{ id: 'call_1', name: 'tasks_list', arguments: '{"text":"юрист"}' }]);
      const second = await llm.chat({
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: 'я відповів юристу' },
          { role: 'assistant', content: null, toolCalls: first.toolCalls, raw: first.raw },
          { role: 'tool', toolCallId: 'call_1', content: '[]' },
        ],
        tools,
      });
      expect(second.content).toBe('Готово, знайшла.');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls.every((u) => u.endsWith('/responses'))).toBe(true);
    expect(bodies[0]).toMatchObject({ model: 'gpt-6.1-sol', instructions: 'SYS', store: false, reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'] });
    expect(bodies[0].temperature).toBeUndefined(); // reasoning models reject it
    expect(bodies[0].tools[0]).toMatchObject({ type: 'function', name: 'tasks_list' });
    // step 2: encrypted reasoning + the call go back verbatim (server ids stripped), then the tool output
    expect(bodies[1].input).toEqual([
      { role: 'user', content: 'я відповів юристу' },
      { type: 'reasoning', encrypted_content: 'ENC', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'tasks_list', arguments: '{"text":"юрист"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '[]' },
    ]);
  });

  it('older models stay on chat completions', () => {
    expect(OpenAi.usesResponses('gpt-4.1')).toBe(false);
    expect(OpenAi.usesResponses('gpt-4.1-mini')).toBe(false);
    expect(OpenAi.usesResponses('gpt-6.1-sol')).toBe(true);
    expect(OpenAi.usesResponses('gpt-5.4-mini')).toBe(true);
    expect(OpenAi.usesResponses('o3')).toBe(true);
  });
});
