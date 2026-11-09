import { describe, expect, it, vi } from 'vitest';
import { runPending } from '../src/actions.js';
import { buildTools } from '../src/agent/tools.js';
import { FallbackTts } from '../src/integrations/tts.js';
import { notionAllows } from '../src/integrations/runtime.js';
import { mdToBlocks } from '../src/notion/blocks.js';
import { IntegrationStore } from '../src/store/integrations.js';
import { makeEnv } from './helpers/services.js';

function fakeApi() {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  return {
    calls,
    async request(method: string, path: string, body?: any) {
      calls.push({ method, path, body });
      if (path.startsWith('/v1/blocks/center/children'))
        return { results: [{ id: 'p-fin', type: 'child_page', has_children: true, child_page: { title: 'MLI · Фінанси' } }], has_more: false };
      if (path === '/v1/pages/center') return { properties: { title: { type: 'title', title: [{ plain_text: 'Управлінський центр' }] } } };
      if (method === 'POST' && path === '/v1/pages') return { id: 'new-page', url: 'https://notion.so/new-page' };
      return { results: [], has_more: false };
    },
  };
}

async function setup(access: 'read' | 'create') {
  const env = await makeEnv({ settings: { notionContextPages: ['center'] } });
  env.s.integrations = new IntegrationStore(env.db, env.s.cfg.ENCRYPTION_KEY);
  await env.s.integrations.patch('notion', { token: 'ntn_test', access, readOnly: access === 'read' });
  const api = fakeApi();
  env.s.notionApi = api as never;
  const tool = buildTools().find((t) => t.name === 'notion_page_create')!;
  const ctx = { s: env.s, chatId: 1, proposals: [] as any[] };
  return { env, api, tool, ctx };
}

describe('Markdown -> Notion blocks', () => {
  it('keeps headings, lists, to-dos, tables and bold text', () => {
    const b = mdToBlocks('# Витрати жовтня\n\n**Разом:** 1 200 ₴\n- Таксі\n1. Перше\n- [x] Оплачено\n\n| Дата | Сума |\n|---|---|\n| 03.10 | 200 |\n| 05.10 | 1 000 |\n---');
    expect(b.map((x) => x.type)).toEqual(['heading_1', 'paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'table', 'divider']);
    expect(b[1].paragraph.rich_text[0]).toMatchObject({ text: { content: 'Разом:' }, annotations: { bold: true } });
    expect(b[5].table).toMatchObject({ table_width: 2, has_column_header: true });
    expect(b[5].table.children).toHaveLength(3);
    expect(b[5].table.children[2].table_row.cells[1][0].text.content).toBe('1 000');
  });
});

describe('Notion «create» mode', () => {
  it('allows adding new things but never changing existing ones', async () => {
    const { env } = await setup('create');
    for (const k of ['task.create', 'page.create', 'decision.log', 'waiting.add', 'finance.record', 'note.save']) expect(await notionAllows(env.s, k)).toBe(true);
    for (const k of ['task.update', 'task.complete', 'task.reschedule', 'waiting.resolve']) expect(await notionAllows(env.s, k)).toBe(false);
  });

  it('read-only: the document is not even proposed', async () => {
    const { tool, ctx, api } = await setup('read');
    expect(await tool.run({ title: 'Звіт', content: '# Звіт' }, ctx)).toMatchObject({ status: 'read_only' });
    expect(ctx.proposals).toHaveLength(0);
    expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a new document inside a sub-page is created only after confirmation', async () => {
    const { env, tool, ctx, api } = await setup('create');
    const r: any = await tool.run({ title: 'Звіт витрат · жовтень', content: '# Витрати\n- Таксі 200 ₴', under: 'фінанси' }, ctx);
    expect(r.status).toBe('awaiting_confirmation');
    expect(r.summary).toContain('«MLI · Фінанси»');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    const done = await runPending(env.s, r.action_id);
    expect(done.ok).toBe(true);
    expect(done.text).toContain('https://notion.so/new-page');
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body.parent).toEqual({ page_id: 'p-fin' });
    expect(post.body.properties.title.title[0].text.content).toBe('Звіт витрат · жовтень');
    expect(post.body.children.map((b: any) => b.type)).toEqual(['heading_1', 'bulleted_list_item']);
  });

  it('without «under» the document goes into the centre itself', async () => {
    const { tool, ctx } = await setup('create');
    const r: any = await tool.run({ title: 'План', content: 'текст' }, ctx);
    expect(r.summary).toContain('«Управлінський центр»');
  });
});

describe('voice fallback', () => {
  it('speaks with OpenAI when ElevenLabs refuses (unpaid subscription)', async () => {
    const onFallback = vi.fn();
    const tts = new FallbackTts(
      { speak: async () => Promise.reject(new Error('HTTP 401 payment_required')) },
      { speak: async () => new Uint8Array([7]) },
      onFallback,
    );
    expect(await tts.speak('привіт', { voice: 'eleven-voice' })).toEqual(new Uint8Array([7]));
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('a stream that already started is not replayed in another voice', async () => {
    const backup = { speak: async () => new Uint8Array(), streamPcm: vi.fn(async () => {}) };
    const tts = new FallbackTts(
      {
        speak: async () => new Uint8Array(),
        streamPcm: async (_t: string, on: (c: Uint8Array) => void) => {
          on(new Uint8Array([1, 2]));
          throw new Error('cut');
        },
      },
      backup,
    );
    await expect(tts.streamPcm('x', () => {})).rejects.toThrow('cut');
    expect(backup.streamPcm).not.toHaveBeenCalled();
  });
});

describe('voice provider behind the fallback', () => {
  it('the cabinet still sees ElevenLabs (its voices, its preview) when it is wrapped in a fallback', async () => {
    const { ElevenLabs, OpenAiTts, ttsProvider } = await import('../src/integrations/tts.js');
    const eleven = new ElevenLabs('k', { fast: 'f', quality: 'q' }, async () => ({ voice: 'v', style: 'natural' }));
    expect(ttsProvider(new FallbackTts(eleven, new OpenAiTts('k')))).toBe('elevenlabs');
    expect(ttsProvider(new OpenAiTts('k'))).toBe('openai');
    expect(ttsProvider(undefined)).toBe('none');
  });
});
