import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOpenAi } from '../src/web/integrations-api.js';

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI key check', () => {
  it('passes when a tiny request goes through', async () => {
    const f = reply(200, { id: 'resp_1', status: 'completed' });
    vi.stubGlobal('fetch', f);
    expect(await checkOpenAi('sk-test', 'gpt-x')).toBeUndefined();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-x', max_output_tokens: 16 });
  });

  it('says plainly when the balance is empty', async () => {
    vi.stubGlobal('fetch', reply(429, { error: { message: 'You have no credits remaining.', type: 'insufficient_quota' } }));
    expect(await checkOpenAi('sk-test', 'gpt-x')).toContain('немає кредитів');
  });

  it('tells a wrong key and a missing model apart', async () => {
    vi.stubGlobal('fetch', reply(401, { error: { message: 'Incorrect API key' } }));
    expect(await checkOpenAi('sk-test', 'gpt-x')).toContain('не прийняв ключ');
    vi.stubGlobal('fetch', reply(404, { error: { message: 'model not found' } }));
    expect(await checkOpenAi('sk-test', 'gpt-x')).toContain('gpt-x');
  });
});
