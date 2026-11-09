import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { createBot } from '../src/telegram/bot.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

const OWNER = 42;

async function setup() {
  const env = await makeEnv();
  const spoken: string[] = [];
  env.s.tts = { speak: async (text: string) => (spoken.push(text), new Uint8Array([1, 2, 3])) } as never;
  const bot = createBot(env.s, new Agent(env.s));
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as never;
  const calls: string[] = [];
  bot.api.config.use(async (_prev, method, payload: any) => {
    calls.push(method === 'sendMessage' ? `text:${payload.text}` : method);
    return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: 'private' } } } as never;
  });
  let n = 0;
  const write = (text: string) =>
    bot.handleUpdate({
      update_id: ++n,
      message: { message_id: n, date: 0, text, chat: { id: OWNER, type: 'private', first_name: 'Ірина' }, from: { id: OWNER, is_bot: false, first_name: 'Ірина' } },
    } as never);
  return { env, spoken, calls, write };
}

describe('voice replies on request', () => {
  it('a typed "say it by voice" gets a voice message even in mirror mode', async () => {
    const { env, spoken, calls, write } = await setup();
    env.llm.script.push(toolCall('reply_voice', {}), say('На сьогодні гінеколог о 14:30.'));
    await write('голосовим скажи, що на сьогодні');
    expect(spoken).toEqual(['На сьогодні гінеколог о 14:30.']);
    expect(calls.some((c) => c === 'sendVoice' || c === 'sendAudio')).toBe(true);
    expect(calls.filter((c) => c.startsWith('text:'))).toEqual([]);
  });

  it('an ordinary typed message in mirror mode is still answered with text', async () => {
    const { env, spoken, calls, write } = await setup();
    env.llm.script.push(say('Привіт!'));
    await write('привіт');
    expect(spoken).toEqual([]);
    expect(calls).toContain('text:Привіт!');
  });

  it('the system prompt tells the model it can answer by voice', async () => {
    const { env, write } = await setup();
    env.llm.script.push(say('ок'));
    await write('привіт');
    const system = env.llm.calls[0]!.messages[0]!.content as string;
    expect(system).toContain('reply_voice');
  });
});
