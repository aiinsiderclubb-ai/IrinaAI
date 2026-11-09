import { describe, expect, it } from 'vitest';
import { runPending } from '../src/actions.js';
import { Agent } from '../src/agent/agent.js';
import { GoogleCalendar } from '../src/integrations/google-calendar.js';
import { IntegrationStore } from '../src/store/integrations.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

// clock: 2026-10-23 08:00 Kyiv (UTC+3)
async function setup() {
  const env = await makeEnv();
  const ev = env.calendar.add('work', { title: 'Тренування', start: '2026-10-23T16:30:00+03:00', end: '2026-10-23T17:30:00+03:00' });
  return { env, ev, agent: new Agent(env.s) };
}

describe('calendar: move, edit, delete', () => {
  it('calendar_list exposes event ids so the model can point at an event', async () => {
    const { env, ev, agent } = await setup();
    env.llm.script.push(toolCall('calendar_list', { from: '2026-10-23', to: '2026-10-23' }), (m) => {
      expect(String(m.at(-1)!.content)).toContain(`"id":"${ev.id}"`);
      return say('ок');
    });
    await agent.handle(42, 'що сьогодні?');
  });

  it('moving keeps the duration and changes nothing before confirmation', async () => {
    const { env, ev, agent } = await setup();
    env.llm.script.push(toolCall('calendar_update', { event_id: ev.id, calendar: 'work', start: '2026-10-24T10:00' }), say('Підготувала перенесення.'));
    const r = await agent.handle(42, 'перенеси тренування на завтра на 10');
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.kind).toBe('calendar.update');
    expect(r.proposals[0]!.summary).toContain('23.10 16:30–17:30 → 24.10 10:00–11:00');
    expect(env.calendar.calls.patch).toBe(0);

    const done = await runPending(env.s, r.proposals[0]!.id);
    expect(done.ok).toBe(true);
    const moved = await env.calendar.get('work', ev.id);
    expect(new Date(moved!.start).toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(new Date(moved!.end).toISOString()).toBe('2026-10-24T08:00:00.000Z');
  });

  it('deletes only after confirmation', async () => {
    const { env, ev, agent } = await setup();
    env.llm.script.push(toolCall('calendar_delete', { event_id: ev.id, calendar: 'work' }), say('Підтверди видалення.'));
    const r = await agent.handle(42, 'видали тренування');
    expect(r.proposals[0]!.summary).toContain('Видалити подію «Тренування» 23.10 16:30–17:30');
    expect(env.calendar.events.work).toHaveLength(1);
    expect((await runPending(env.s, r.proposals[0]!.id)).text).toContain('видалено');
    expect(env.calendar.events.work).toHaveLength(0);
  });

  it('refuses unknown ids and mirror copies', async () => {
    const { env, agent } = await setup();
    const mirror = env.calendar.add('personal', { title: 'Зайнято', start: '2026-10-23T12:00:00+03:00', end: '2026-10-23T13:00:00+03:00', mirror: true });
    env.llm.script.push(
      toolCall('calendar_delete', { event_id: 'nope', calendar: 'work' }),
      (m) => (expect(String(m.at(-1)!.content)).toContain('не знайдено'), toolCall('calendar_delete', { event_id: mirror.id, calendar: 'personal' })),
      (m) => (expect(String(m.at(-1)!.content)).toContain('віддзеркалення'), say('Не можу.')),
    );
    expect((await agent.handle(42, 'видали')).proposals).toHaveLength(0);
  });

  it('stays blocked while the calendar is read-only', async () => {
    const { env, ev, agent } = await setup();
    env.s.integrations = new IntegrationStore(env.db, env.s.cfg.ENCRYPTION_KEY);
    await env.s.integrations.patch('google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec' });
    env.llm.script.push(toolCall('calendar_delete', { event_id: ev.id, calendar: 'work' }), (m) => (expect(String(m.at(-1)!.content)).toContain('read_only'), say('Лише читання.')));
    expect((await agent.handle(42, 'видали тренування')).proposals).toHaveLength(0);
  });

  it('Google client: all-day moves send dates, timed moves send date-times', async () => {
    const sent: any[] = [];
    const auth = { authedJson: async (_slot: string, _url: string, o: any) => (sent.push(o.json), {}) };
    const cal = new GoogleCalendar(auth as never);
    await cal.patch('work', 'e1', { start: '2026-10-24', end: '2026-10-25', allDay: true });
    await cal.patch('work', 'e2', { start: '2026-10-24T10:00:00+03:00', end: '2026-10-24T11:00:00+03:00', timeZone: 'Europe/Kyiv' });
    expect(sent[0].start).toEqual({ date: '2026-10-24', dateTime: null });
    expect(sent[1].start).toEqual({ dateTime: '2026-10-24T10:00:00+03:00', timeZone: 'Europe/Kyiv', date: null });
  });
});
