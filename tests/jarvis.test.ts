import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { Agent, buildSystemPrompt } from '../src/agent/agent.js';
import { isSpokenYes } from '../src/agent/tools.js';
import { computeNudges, runNudges } from '../src/modules/nudges.js';
import { buildJobs, tick } from '../src/scheduler.js';
import { buildServer } from '../src/server.js';
import { registerWeb } from '../src/web/api.js';
import { issueSession, SESSION_COOKIE } from '../src/web/auth.js';
import type { CalEvent } from '../src/integrations/google-calendar.js';
import { isAddressed } from '../src/lib/wake.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

const H = { 'x-requested-with': 'aia' };

describe('memory', () => {
  it('saves via the agent, updates the same subject, lands in the prompt, refuses secrets', async () => {
    const env = await makeEnv({ settings: { assistantName: 'Аріна', ownerName: 'Ірино' } });
    env.llm.script.push(toolCall('memory_save', { subject: 'Олена', content: 'юрист компанії, відповідає за NDA', kind: 'person' }), say('Запам’ятала.'));
    await new Agent(env.s).handle(42, 'Олена — наш юрист');
    await env.s.memory.remember('Олена', 'юрист, на зв’язку з 10:00', 'person');
    expect(await env.s.memory.list()).toHaveLength(1);
    const prompt = await buildSystemPrompt(env.s);
    expect(prompt).toContain('Тебе звати Аріна');
    expect(prompt).toContain('на «ти»');
    expect(prompt).toContain('Олена: юрист, на зв’язку з 10:00');

    env.llm.script.push(toolCall('memory_save', { subject: 'картка', content: 'номер 4441114416192860' }), (m) => {
      expect(JSON.stringify(m.at(-1))).toContain('refused');
      return say('Не зберігаю таке.');
    });
    await new Agent(env.s).handle(42, 'запам’ятай мою картку');
    expect(await env.s.memory.list()).toHaveLength(1);
  });
});

describe('voice confirmation', () => {
  it('recognises a spoken yes and refuses when the owner said no', () => {
    for (const t of ['Так', 'так, давай', 'Підтверджую.', 'ок', 'добре, роби', 'Tak, bitverđujo.']) expect(isSpokenYes(t)).toBe(true);
    for (const t of ['ні', 'Ні, не треба', 'скасуй', 'так, але ні', 'зачекай', 'Ni', 'Taktika', undefined]) expect(isSpokenYes(t)).toBe(false);
  });

  it('pending_confirm runs only after the owner said yes', async () => {
    const env = await makeEnv();
    const app = buildServer(env.s, {} as never);
    await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false, realtimeSecret: async () => ({ value: 'ek_test', expiresAt: 0 }) });
    const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, 42, env.s.clock().getTime())}`;
    const tool = (name: string, args: unknown, lastUserText?: string) =>
      app.inject({ method: 'POST', url: '/api/realtime/tool', headers: { ...H, cookie }, payload: { name, arguments: JSON.stringify(args), lastUserText } }).then((r) => r.json());

    const created = await tool('task_create', { title: 'Голосова задача', project: 'Alpha' }, 'додай задачу голосова задача');
    expect(created.proposals).toHaveLength(1);
    const actionId = JSON.parse(created.output).action_id;
    expect(actionId).toBe(created.proposals[0].id);

    expect(JSON.parse((await tool('pending_confirm', { action_id: actionId }, 'зачекай')).output).status).toBe('not_confirmed');
    expect(env.notion.titles('tasks')).toEqual([]);
    expect(JSON.parse((await tool('pending_confirm', { action_id: actionId }, 'так, підтверджую')).output).status).toBe('done');
    expect(env.notion.titles('tasks')).toEqual(['Голосова задача']);
  });
});

describe('voice agent across turns', () => {
  it('a spoken «так» in the next request confirms the action prepared in the previous one', async () => {
    const env = await makeEnv();
    const { buildVoiceTools } = await import('../src/agent/tools.js');
    const agent = new Agent(env.s, buildVoiceTools(), 'voice');
    env.llm.script.push(toolCall('task_create', { title: 'Зателефонувати Андрію', project: 'Alpha' }), say('Готую задачу. Підтверджуєш?'));
    await agent.handle(42, 'додай задачу зателефонувати Андрію');
    const [pending] = await env.s.pending.listPending();
    env.llm.script.push((m) => {
      expect(String(m[0]!.content)).toContain(`action_id=${pending!.id}`);
      return toolCall('pending_confirm', { action_id: pending!.id });
    }, say('Готово.'));
    await agent.handle(42, 'Так, підтверджую.');
    expect(env.notion.titles('tasks')).toEqual(['Зателефонувати Андрію']);
    expect(await env.s.pending.listPending()).toHaveLength(0);
  });
});

describe('realtime session', () => {
  it('passes tools + personality to OpenAI, hands-free disables auto replies, greets once a day', async () => {
    const env = await makeEnv({ settings: { assistantName: 'Аріна' } });
    const sessions: any[] = [];
    const app = buildServer(env.s, {} as never);
    await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false, realtimeSecret: async (session) => (sessions.push(session), { value: 'ek_1', expiresAt: 1 }) });
    const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, 42, env.s.clock().getTime())}`;
    const open = (handsFree: boolean) => app.inject({ method: 'POST', url: '/api/realtime/session', headers: { ...H, cookie }, payload: { handsFree } }).then((r) => r.json());

    const first = await open(false);
    expect(first).toMatchObject({ value: 'ek_1', assistantName: 'Аріна', greet: true, model: 'gpt-realtime' });
    expect((await open(true)).greet).toBe(false);

    const [normal, handsFree] = sessions;
    expect(normal.audio.input.turn_detection.create_response).toBe(true);
    expect(handsFree.audio.input.turn_detection.create_response).toBe(false);
    expect(normal.audio.input.transcription.language).toBe('uk');
    const names = normal.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['task_create', 'calendar_list', 'memory_save', 'pending_confirm', 'pending_cancel']));
    expect(normal.tools.every((t: any) => t.type === 'function' && t.parameters?.type === 'object')).toBe(true);
    expect(normal.instructions).toContain('голосовий діалог');
    expect(normal.instructions).toContain('pending_confirm');

    await app.inject({ method: 'POST', url: '/api/realtime/transcript', headers: { ...H, cookie }, payload: { role: 'user', text: 'привіт' } });
    expect((await env.s.messages.recent(42)).map((m) => m.content)).toContain('🎙 привіт');
  });
});

describe('wake word', () => {
  it('answers only when called by name, including the vocative', () => {
    expect(isAddressed('Аріно, що в мене далі?', 'Аріна')).toBe(true);
    expect(isAddressed('аріна перенеси зустріч', 'Аріна')).toBe(true);
    expect(isAddressed('Джарвісе, скільки часу?', 'Джарвіс')).toBe(true);
    expect(isAddressed('Ми з Іриною обговорюємо бюджет', 'Аріна')).toBe(false);
    expect(isAddressed('давай пізніше', 'Джарвіс')).toBe(false);
  });
});

describe('proactive nudges', () => {
  const zone = 'Europe/Kyiv';
  const ev = (id: string, start: string, extra: Partial<CalEvent> = {}): CalEvent => ({
    id, account: 'work', title: id, start, end: DateTime.fromISO(start).plus({ hours: 1 }).toISO()!, allDay: false, busy: true, mirror: false, cancelled: false, ...extra,
  });

  it('meeting within 15 minutes, overdue replies after 10:00, unfinished deadlines after 16:00', () => {
    const at = (iso: string) => DateTime.fromISO(iso, { zone });
    const events = [ev('Зустріч з фондом', '2026-10-23T11:00:00+03:00', { location: 'Zoom' }), ev('Пізніше', '2026-10-23T13:00:00+03:00'), ev('Дзеркало', '2026-10-23T11:00:00+03:00', { mirror: true })];
    const waiting = [{ id: 'w1', title: 'NDA', from: 'Олена', due: '2026-10-21', open: true }, { id: 'w2', title: 'Ще не час', due: '2026-10-30', open: true }];
    const tasks = [{ id: 't1', title: 'Бюджет', status: 'Not started', done: false, due: '2026-10-23' }];

    const morning = computeNudges({ now: at('2026-10-23T09:00'), events, openTasks: tasks, waiting });
    expect(morning).toEqual([]);
    const beforeMeeting = computeNudges({ now: at('2026-10-23T10:50'), events, openTasks: tasks, waiting });
    expect(beforeMeeting.map((n) => n.text)).toEqual(['Через 10 хв — «Зустріч з фондом» (Zoom).', '«NDA» від Олена досі без відповіді (чекали до 2026-10-21). Нагадати чи перенести?']);
    const afternoon = computeNudges({ now: at('2026-10-23T16:05'), events, openTasks: tasks, waiting });
    expect(afternoon.map((n) => n.key)).toEqual(['wait:w1:2026-10-23', 'due:2026-10-23']);
  });

  it('job says each thing once, to Telegram, and the web picks it up', async () => {
    const env = await makeEnv({ now: '2026-10-23T07:50:00Z' }); // 10:50 Kyiv
    env.calendar.add('work', { title: 'Зустріч з фондом', start: '2026-10-23T11:00:00+03:00', end: '2026-10-23T12:00:00+03:00' });
    const jobs = buildJobs().filter((j) => j.name === 'nudges');
    await tick(env.s, jobs);
    expect(env.notified).toEqual(['🔔 Через 10 хв — «Зустріч з фондом».']);
    env.setNow('2026-10-23T07:52:00Z');
    await tick(env.s, jobs);
    expect(env.notified).toHaveLength(1);
    expect(await runNudges(env.s)).toEqual([]);

    const app = buildServer(env.s, {} as never);
    await registerWeb(app, env.s, new Agent(env.s), { serveStatic: false });
    const cookie = `${SESSION_COOKIE}=${issueSession(env.s.cfg.APP_SECRET, 42, env.s.clock().getTime())}`;
    const items = (await app.inject({ url: '/api/nudges?after=2000-01-01T00:00:00Z', headers: { cookie } })).json().items;
    expect(items.map((n: { text: string }) => n.text)).toEqual(['Через 10 хв — «Зустріч з фондом».']);
  });
});

describe('calendar timing for "what is next"', () => {
  it('marks past / ongoing / upcoming and names the next event', async () => {
    const env = await makeEnv({ now: '2026-10-23T11:57:00Z' }); // 14:57 Kyiv
    env.calendar.add('work', { title: 'Нарада', start: '2026-10-23T11:00:00+03:00', end: '2026-10-23T12:00:00+03:00' });
    env.calendar.add('work', { title: 'Рев’ю', start: '2026-10-23T15:00:00+03:00', end: '2026-10-23T16:00:00+03:00' });
    env.calendar.add('personal', { title: 'Тренування', start: '2026-10-23T19:00:00+03:00', end: '2026-10-23T20:00:00+03:00' });
    let out: any;
    env.llm.script.push(toolCall('calendar_list', { from: '2026-10-23', to: '2026-10-23' }), (m) => {
      out = JSON.parse(String((m.at(-1) as { content: string }).content));
      return say('ok');
    });
    await new Agent(env.s).handle(42, 'що далі?');
    expect(out.next).toBe('Рев’ю о 15:00');
    expect(out.events.map((e: any) => [e.title, e.status, e.starts_in_min])).toEqual([
      ['Нарада', 'past', undefined],
      ['Рев’ю', 'upcoming', 3],
      ['Тренування', 'upcoming', 243],
    ]);
  });
});
