import { describe, expect, it } from 'vitest';
import { runPending } from '../src/actions.js';
import { Agent } from '../src/agent/agent.js';
import { say, toolCall, makeEnv } from './helpers/services.js';

/** Owner says X -> model calls tools -> action waits -> owner confirms -> data changes. */
describe('confirmation gate (contract 2.5)', () => {
  it('task_create only proposes; the task appears after confirmation', async () => {
    const env = await makeEnv();
    env.llm.script.push(
      toolCall('task_create', { title: 'Надіслати договір клієнту', project: 'alpha', due: '2026-10-24' }),
      say('Підготував задачу. Підтвердьте.'),
    );
    const reply = await new Agent(env.s).handle(42, 'Додай задачу надіслати договір клієнту в Alpha на завтра');

    expect(reply.proposals).toHaveLength(1);
    expect(reply.proposals[0]!.summary).toContain('Alpha');
    expect(env.notion.titles('tasks')).toEqual([]); // nothing written yet

    const res = await runPending(env.s, reply.proposals[0]!.id);
    expect(res.ok).toBe(true);
    expect(env.notion.titles('tasks')).toEqual(['Надіслати договір клієнту']);
    const [task] = await (await env.s.notion()).queryTasks({ project: 'Alpha' });
    expect(task).toMatchObject({ project: 'Alpha', due: '2026-10-24' }); // canonical project name, right deadline
  });

  it('a double tap on Confirm runs the action once', async () => {
    const env = await makeEnv();
    env.llm.script.push(toolCall('task_create', { title: 'Одна задача', project: 'Alpha' }), say('ok'));
    const reply = await new Agent(env.s).handle(42, 'додай');
    const id = reply.proposals[0]!.id;
    const [a, b] = await Promise.all([runPending(env.s, id), runPending(env.s, id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(env.notion.titles('tasks')).toHaveLength(1);
  });

  it('refuses a duplicate instead of creating a second task', async () => {
    const env = await makeEnv();
    await (await env.s.notion()).createTask({ title: 'Підготувати презентацію', project: 'Alpha' });
    env.llm.script.push(toolCall('task_create', { title: 'підготувати презентацію', project: 'Alpha' }), (m) => {
      const toolMsg = m.find((x) => x.role === 'tool');
      expect(toolMsg && 'content' in toolMsg && toolMsg.content).toContain('duplicate');
      return say('Така задача вже є.');
    });
    const reply = await new Agent(env.s).handle(42, 'додай задачу підготувати презентацію в Alpha');
    expect(reply.proposals).toHaveLength(0);
    expect(env.notion.titles('tasks')).toHaveLength(1);
  });

  it('completes a task via list -> complete -> confirm and does not touch it again', async () => {
    const env = await makeEnv();
    const notion = await env.s.notion();
    const t = await notion.createTask({ title: 'Оплатити хостинг', project: 'Beta', due: '2026-10-23' });
    env.llm.script.push(toolCall('tasks_list', { text: 'хостинг' }, 'c1'), toolCall('task_complete', { task_id: t.id }, 'c2'), say('Підтвердьте завершення.'));
    const reply = await new Agent(env.s).handle(42, 'я оплатив хостинг');
    expect(reply.proposals[0]!.kind).toBe('task.complete');
    expect((await notion.getTask(t.id)).done).toBe(false);
    await runPending(env.s, reply.proposals[0]!.id);
    expect((await notion.getTask(t.id)).done).toBe(true);
    expect(await notion.queryTasks({ open: true, dueOnOrBefore: '2026-10-30' })).toHaveLength(0); // not carried to tomorrow
  });

  it('cancelled actions change nothing', async () => {
    const env = await makeEnv();
    env.llm.script.push(toolCall('task_create', { title: 'Скасована задача', project: 'Alpha' }), say('ok'));
    const reply = await new Agent(env.s).handle(42, 'додай');
    expect(await env.s.pending.cancel(reply.proposals[0]!.id)).toBe(true);
    expect((await runPending(env.s, reply.proposals[0]!.id)).ok).toBe(false);
    expect(env.notion.titles('tasks')).toHaveLength(0);
  });

  it('unknown project is reported back to the model, not guessed', async () => {
    const env = await makeEnv();
    env.llm.script.push(toolCall('task_create', { title: 'Щось', project: 'Gamma' }), (m) => {
      expect(JSON.stringify(m.at(-1))).toContain('Alpha, Beta');
      return say('Який проєкт: Alpha чи Beta?');
    });
    const reply = await new Agent(env.s).handle(42, 'додай задачу щось в Gamma');
    expect(reply.proposals).toHaveLength(0);
    expect(reply.text).toContain('Alpha');
  });
});

describe('finance by phrase', () => {
  it('«мінус 45 доларів, таксі, особисте» -> row with category, then period total matches', async () => {
    const env = await makeEnv();
    const agent = new Agent(env.s);
    env.llm.script.push(toolCall('finance_record', { amount: 45, currency: 'USD', kind: 'expense', category: 'Таксі', scope: 'personal', note: 'таксі' }), say('Підтвердьте запис.'));
    const reply = await agent.handle(42, 'мінус 45 доларів, таксі, особисте');
    await runPending(env.s, reply.proposals[0]!.id);
    env.llm.script.push(toolCall('finance_record', { amount: 15.5, currency: 'USD', kind: 'expense', category: 'Їжа', scope: 'personal' }), say('ok'));
    await runPending(env.s, (await agent.handle(42, 'мінус 15.5 їжа особисте')).proposals[0]!.id);

    const rows = await (await env.s.notion()).queryFinance('2026-10-01', '2026-10-31');
    expect(rows.map((r) => [r.amount, r.category, r.scope, r.date])).toEqual([[45, 'Таксі', 'personal', '2026-10-23'], [15.5, 'Їжа', 'personal', '2026-10-23']]);

    let summaryJson = '';
    env.llm.script.push(toolCall('finance_summary', { from: '2026-10-01', to: '2026-10-31' }), (m) => {
      summaryJson = JSON.stringify(m.at(-1));
      return say('ok');
    });
    await agent.handle(42, 'скільки я витратив у жовтні?');
    expect(summaryJson).toContain('60,5 USD');
  });

  it('category outside the client list is bounced back with the allowed ones', async () => {
    const env = await makeEnv();
    env.llm.script.push(toolCall('finance_record', { amount: 10, kind: 'expense', category: 'Яхти', scope: 'personal' }), say('Яка категорія?'));
    const reply = await new Agent(env.s).handle(42, 'мінус 10 яхти');
    expect(reply.proposals).toHaveLength(0);
    expect(JSON.stringify(env.llm.calls[1]!.messages.at(-1))).toContain('Таксі, Їжа');
  });
});

describe('calendar tools', () => {
  it('create event: flags the conflict, writes only after confirm, lands in the right calendar', async () => {
    const env = await makeEnv();
    env.calendar.add('work', { title: 'Стендап', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T10:30:00+03:00' });
    env.llm.script.push(toolCall('calendar_create', { title: 'Дзвінок з клієнтом', start: '2026-10-23T10:15', end: '2026-10-23T11:00', calendar: 'work' }), say('Є конфлікт зі стендапом.'));
    const reply = await new Agent(env.s).handle(42, 'постав дзвінок з клієнтом на 10:15');
    expect(reply.proposals[0]!.summary).toContain('Конфлікт');
    expect(reply.proposals[0]!.summary).toContain('Стендап');
    expect(env.calendar.calls.create).toBe(0);
    await runPending(env.s, reply.proposals[0]!.id);
    expect(env.calendar.events.work.map((e) => e.title)).toContain('Дзвінок з клієнтом');
    expect(env.calendar.events.work.find((e) => e.title === 'Дзвінок з клієнтом')!.start).toBe('2026-10-23T10:15:00.000+03:00');
  });

  it('plan_day fills free time between meetings and applies after confirm; reschedule moves the linked block', async () => {
    const env = await makeEnv({ now: '2026-10-23T05:00:00Z' }); // 08:00 Kyiv
    env.calendar.add('work', { title: 'Нарада', start: '2026-10-23T10:00:00+03:00', end: '2026-10-23T12:00:00+03:00' });
    const notion = await env.s.notion();
    const t1 = await notion.createTask({ title: 'Написати лист', project: 'Alpha', due: '2026-10-23' });
    await notion.createTask({ title: 'Скласти бюджет', project: 'Beta', due: '2026-10-23', priority: 'High' });
    env.llm.script.push(toolCall('plan_day', {}), say('План готовий.'));
    const agent = new Agent(env.s);
    const reply = await agent.handle(42, 'склади план дня');
    expect(reply.proposals[0]!.kind).toBe('plan.apply');
    await runPending(env.s, reply.proposals[0]!.id);
    const blocks = env.calendar.events.work.filter((e) => e.title.startsWith('🎯'));
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      const overlapsMeeting = new Date(b.start) < new Date('2026-10-23T12:00:00+03:00') && new Date(b.end) > new Date('2026-10-23T10:00:00+03:00');
      expect(overlapsMeeting).toBe(false);
    }
    env.llm.script.push(toolCall('task_reschedule', { task_id: t1.id, new_due: '2026-10-24T09:00', duration_min: 30 }), say('ok'));
    const rs = await agent.handle(42, 'перенеси лист на завтра на 9');
    await runPending(env.s, rs.proposals[0]!.id);
    expect((await notion.getTask(t1.id)).due).toContain('2026-10-24T09:00');
    expect(env.calendar.events.work.find((e) => e.title === '🎯 Написати лист')!.start).toContain('2026-10-24T09:00');
  });
});

describe('settings by command', () => {
  it('changes report time immediately and rejects a bad format', async () => {
    const env = await makeEnv();
    env.llm.script.push(toolCall('settings_set', { morning_time: '07:30' }), say('ok'), toolCall('settings_set', { evening_time: '25:99' }), say('ok'));
    const agent = new Agent(env.s);
    await agent.handle(42, 'ранковий звіт о 7:30');
    expect((await env.s.settings.get()).morningTime).toBe('07:30');
    await agent.handle(42, 'вечірній о 25:99');
    expect((await env.s.settings.get()).eveningTime).toBe('20:00');
  });
});

describe('agent loop safety', () => {
  it('survives malformed tool arguments and unknown tools', async () => {
    const env = await makeEnv();
    env.llm.script.push(
      { content: null, toolCalls: [{ id: '1', name: 'task_create', arguments: '{"title":' }, { id: '2', name: 'rm_rf', arguments: '{}' }] },
      say('Не зміг, уточніть.'),
    );
    const reply = await new Agent(env.s).handle(42, 'x');
    expect(reply.text).toBe('Не зміг, уточніть.');
    expect(reply.proposals).toHaveLength(0);
  });

  it('stops after the step limit', async () => {
    const env = await makeEnv();
    for (let i = 0; i < 10; i++) env.llm.script.push(toolCall('projects_list', {}, `c${i}`));
    const reply = await new Agent(env.s).handle(42, 'loop');
    expect(env.llm.calls.length).toBeLessThanOrEqual(6);
    expect(reply.text).toContain('Не вдалося');
  });

  it('keeps recent history and injects date, projects and rules into the system prompt', async () => {
    const env = await makeEnv();
    const agent = new Agent(env.s);
    env.llm.script.push(say('перша'), say('друга'));
    await agent.handle(42, 'привіт');
    await agent.handle(42, 'ще раз');
    const second = env.llm.calls[1]!.messages;
    expect(second[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(second[0])).toMatch(/2026-10-23[\s\S]*Alpha, Beta/);
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});
