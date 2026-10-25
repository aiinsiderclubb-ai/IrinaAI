import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { buildServer } from '../src/server.js';
import { registerWeb } from '../src/web/api.js';
import { issueSession, SESSION_COOKIE } from '../src/web/auth.js';
import { OrderedSpeech, SentenceSplitter } from '../src/web/speech-stream.js';
import type { Tts } from '../src/integrations/tts.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

const feed = (text: string, size = 5) => {
  const sp = new SentenceSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...sp.push(text.slice(i, i + size)));
  const rest = sp.flush();
  if (rest) out.push(rest);
  return out;
};

describe('sentence splitter', () => {
  it('releases the first sentence early, keeps numbers and merges short later ones', () => {
    expect(feed('Привіт! О 15:00 рев’ю дизайну. Потім тренування. Все.')).toEqual(['Привіт! О 15:00 рев’ю дизайну.', 'Потім тренування. Все.']);
    expect(feed('Витрати 511.5 доларів за жовтень. Найбільше на подорожі.')).toEqual(['Витрати 511.5 доларів за жовтень.', 'Найбільше на подорожі.']);
    expect(feed('Так.')).toEqual(['Так.']);
  });
  it('breaks a long first sentence at a comma so speech starts sooner', () => {
    const parts = feed('Сьогодні в тебе насичений день, зранку стендап, потім зустріч з фондом і стоматолог, а ввечері тренування');
    expect(parts[0]).toBe('Сьогодні в тебе насичений день,');
    expect(parts.join(' ')).toBe('Сьогодні в тебе насичений день, зранку стендап, потім зустріч з фондом і стоматолог, а ввечері тренування');
  });
});

describe('ordered speech', () => {
  it('synthesises in parallel, delivers live and strictly in order', async () => {
    const sent: string[] = [];
    const delays = [40, 5, 1];
    const speech = new OrderedSpeech(
      async (text, onAudio) => {
        const d = delays.shift()!;
        await new Promise((r) => setTimeout(r, d / 2));
        onAudio(`${text}#1`);
        await new Promise((r) => setTimeout(r, d / 2));
        onAudio(`${text}#2`);
      },
      (seq, c) => sent.push('end' in c ? `${seq}:end` : `${seq}:${c.audio}`),
    );
    const t0 = Date.now();
    speech.add('a');
    speech.add('b');
    speech.add('c');
    await speech.done();
    expect(sent).toEqual(['0:a#1', '0:a#2', '0:end', '1:b#1', '1:b#2', '1:end', '2:c#1', '2:c#2', '2:end']);
    expect(Date.now() - t0).toBeLessThan(40 + 5 + 1 + 30); // parallel, not 3 sequential calls
  });
  it('a failed piece is skipped, the rest still plays', async () => {
    const sent: string[] = [];
    const speech = new OrderedSpeech(
      async (text, onAudio) => {
        if (text === 'bad') throw new Error('tts down');
        onAudio(text);
      },
      (seq, c) => sent.push('end' in c ? `${seq}:end` : `${seq}:${c.audio}`),
    );
    speech.add('ok1');
    speech.add('bad');
    speech.add('ok2');
    await speech.done();
    expect(sent).toEqual(['0:ok1', '0:end', '1:end', '2:ok2', '2:end']);
  });
});

describe('/api/voice/stream', () => {
  const setup = async () => {
    const env = await makeEnv();
    const spoken: string[] = [];
    const tts: Tts = {
      speak: async () => new Uint8Array([1]),
      streamPcm: async (text, onChunk) => {
        spoken.push(text);
        onChunk(new Uint8Array([1, 0, 2, 0]));
      },
    };
    env.s.tts = tts;
    const app = buildServer(env.s, {} as never);
    await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false });
    const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, 42, env.s.clock().getTime())}`;
    const call = async (payload: Buffer | Record<string, unknown>, query = '') => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/voice/stream${query}`,
        headers: { 'x-requested-with': 'aia', cookie, 'content-type': Buffer.isBuffer(payload) ? 'audio/webm' : 'application/json' },
        payload,
      });
      return res.body.trim().split('\n').map((l) => JSON.parse(l));
    };
    return { env, spoken, call };
  };

  it('spoken question: transcript, streamed text, audio per sentence in order, done; uses the fast voice model', async () => {
    const { env, spoken, call } = await setup();
    env.llm.transcripts.push('що далі?');
    env.llm.script.push(say('Далі рев’ю дизайну о третій. Після нього тренування о сьомій.'));
    const evs = await call(Buffer.alloc(3000, 1));
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe('transcript');
    expect(types.at(-1)).toBe('done');
    expect(evs.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Далі рев’ю дизайну о третій. Після нього тренування о сьомій.');
    expect(spoken).toEqual(['Далі рев’ю дизайну о третій.', 'Після нього тренування о сьомій.']);
    expect(evs.filter((e) => e.type === 'audio').map((e) => [e.seq, e.format])).toEqual([[0, 'pcm24'], [1, 'pcm24']]);
    expect(types.indexOf('audio')).toBeLessThan(types.lastIndexOf('text') + 3);
    expect(env.llm.calls.at(-1)!.model).toBe('fast');
    expect(env.llm.calls.at(-1)!.messages[0]!.content).toContain('СЬОГОДНІ');
  });

  it('hands-free without the name: skipped, nothing generated', async () => {
    const { env, call } = await setup();
    env.llm.transcripts.push('обговорюємо бюджет');
    const evs = await call(Buffer.alloc(3000, 1), '?handsFree=1&follow=0');
    expect(evs.map((e) => e.type)).toEqual(['transcript', 'skipped', 'done']);
    expect(env.llm.calls).toHaveLength(0);
  });

  it('typed question with the text agent: proposals come as an event, speech can be off', async () => {
    const { env, spoken, call } = await setup();
    env.llm.script.push(toolCall('task_create', { title: 'Нова задача', project: 'Alpha' }), say('Підготував задачу.'));
    const evs = await call({ text: 'додай задачу', agent: 'text', speak: false });
    expect(evs.find((e) => e.type === 'proposals').items[0].summary).toContain('Нова задача');
    expect(evs.some((e) => e.type === 'audio')).toBe(false);
    expect(spoken).toEqual([]);
    expect(env.llm.calls.at(-1)!.model).toBeUndefined();
  });

  it('say: announcement is spoken without calling the model', async () => {
    const { env, spoken, call } = await setup();
    const evs = await call({ say: 'Через десять хвилин зустріч з фондом.' });
    expect(spoken).toEqual(['Через десять хвилин зустріч з фондом.']);
    expect(evs.at(-1)).toMatchObject({ type: 'done', text: 'Через десять хвилин зустріч з фондом.' });
    expect(env.llm.calls).toHaveLength(0);
  });

  it('a model failure becomes an error event, the stream still closes', async () => {
    const { env, call } = await setup();
    env.llm.chat = async () => {
      throw new Error('openai down');
    };
    const evs = await call({ text: 'привіт' });
    expect(evs.at(-1)).toMatchObject({ type: 'error', message: 'openai down' });
  });
});

describe('voice choice', () => {
  it('voice and style from settings are used on every call, preview can override without saving', async () => {
    const { OpenAiTts } = await import('../src/integrations/tts.js');
    const env = await makeEnv({ settings: { ttsVoice: 'cedar', ttsStyle: 'calm' } });
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    }) as never;
    try {
      const tts = new OpenAiTts('k', 'gpt-4o-mini-tts', async () => {
        const st = await env.s.settings.get();
        return { voice: st.ttsVoice, style: st.ttsStyle };
      });
      await tts.speak('раз');
      await env.s.settings.update({ ttsVoice: 'coral', ttsStyle: 'natural' });
      await tts.speak('два');
      await tts.speak('три', { voice: 'ash' });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodies.map((b) => b.voice)).toEqual(['cedar', 'coral', 'ash']);
    expect(bodies[0].instructions).toContain('спокійно');
    expect(bodies[1].instructions).toContain('жива людина');
    expect((await env.s.settings.get()).ttsVoice).toBe('coral');
  });

  it('settings API accepts only known voices and styles', async () => {
    const env = await makeEnv();
    const app = buildServer(env.s, {} as never);
    await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false });
    const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, 42, env.s.clock().getTime())}`;
    const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/api/settings', headers: { 'x-requested-with': 'aia', cookie }, payload });
    expect((await patch({ ttsVoice: 'robot9000' })).statusCode).toBe(400);
    expect((await patch({ ttsVoice: 'verse', ttsStyle: 'energetic' })).json()).toMatchObject({ ttsVoice: 'verse', ttsStyle: 'energetic' });
    const opts = (await app.inject({ url: '/api/voice/options', headers: { cookie } })).json();
    expect(opts.voices.map((v: { id: string }) => v.id)).toContain('coral');
    expect(opts.styles.map((v: { id: string }) => v.id)).toEqual(['natural', 'calm', 'energetic', 'business']);
  });
});
