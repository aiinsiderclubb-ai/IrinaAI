import { describe, expect, it } from 'vitest';
import { buildEveningReport, buildMorningReport } from '../src/modules/reports.js';
import { saveSnapshot } from '../src/modules/social.js';
import { buildJobs, claimJob, tick } from '../src/scheduler.js';
import { formatEvents, filterNew, parseEvents, searchEvents } from '../src/modules/events.js';
import { formatSocial, diffTotals } from '../src/modules/social.js';
import type { SocialData } from '../src/integrations/social-types.js';
import { say, makeEnv } from './helpers/services.js';

const SECTIONS_MORNING = ['Графік дня', 'Три головні пріоритети', 'Додаткові задачі', 'Зустрічі та підготовка', 'Очікую відповіді', 'Дедлайни найближчих днів'];
const SECTIONS_EVENING = ['Завершено сьогодні', 'Не завершено', 'Нові рішення та домовленості', 'Пріоритети на завтра'];

async function seed(env: Awaited<ReturnType<typeof makeEnv>>) {
  const notion = await env.s.notion();
  await notion.createTask({ title: 'Скласти бюджет', project: 'Alpha', due: '2026-10-23', priority: 'High' });
  await notion.createTask({ title: 'Лист інвестору', project: 'Beta', due: '2026-10-23' });
  await notion.createTask({ title: 'Звіт за квартал', project: 'Alpha', due: '2026-10-25' });
  await notion.addWaiting({ title: 'Відповідь по договору', from: 'Олена', due: '2026-10-24' });
  env.calendar.add('work', { title: 'Нарада з командою', start: '2026-10-23T11:00:00+03:00', end: '2026-10-23T12:00:00+03:00' });
  env.calendar.add('personal', { title: 'Лікар', start: '2026-10-23T11:30:00+03:00', end: '2026-10-23T12:30:00+03:00' });
  return notion;
}

describe('morning report', () => {
  it('has every required section filled from real data, flags conflicts, ignores mirrors', async () => {
    const env = await makeEnv();
    await seed(env);
    env.calendar.add('personal', { title: 'Зайнято', start: '2026-10-23T11:00:00+03:00', end: '2026-10-23T12:00:00+03:00', mirror: true });
    const t = (await (await env.s.notion()).queryTasks({ text: 'бюджет' }))[0]!;
    env.llm.script.push({ content: JSON.stringify({ priorities: [t.id, 'invented-id'], prep: [{ event: 'Нарада', note: 'Підготуйте бюджет' }] }), toolCalls: [] });
    const html = await buildMorningReport(env.s);
    for (const s of SECTIONS_MORNING) expect(html).toContain(s);
    expect(html).toContain('Скласти бюджет');
    expect(html).toContain('<b>11:00–12:00</b>  Нарада з командою');
    expect(html).toContain('Конфлікти');
    expect(html).toContain('Підготуйте бюджет');
    expect(html).toContain('Олена');
    expect(html).toContain('Звіт за квартал'); // upcoming deadline
    expect(html).not.toContain('invented-id');
    expect((html.match(/Зайнято/g) ?? []).length).toBe(0);
  });

  it('falls back to deterministic priorities when the model fails, and degrades one section when a source is down', async () => {
    const env = await makeEnv();
    await seed(env);
    env.llm.chat = async () => {
      throw new Error('openai down');
    };
    env.calendar.list = async () => {
      throw new Error('calendar down');
    };
    const html = await buildMorningReport(env.s);
    for (const s of ['Графік дня', 'Три головні пріоритети', 'Очікую відповіді', 'Дедлайни найближчих днів']) expect(html).toContain(s);
    // nothing extra and no prep notes without the model: those sections fold into one line
    expect(html).toContain('Без новин: додаткові задачі, підготовка до зустрічей');
    expect(html).toContain('Скласти бюджет'); // High priority first
    expect(html).toContain('calendar down');
  });
});

describe('evening report', () => {
  it('shows done, unfinished, new decisions and tomorrow priorities', async () => {
    const env = await makeEnv({ now: '2026-10-23T17:00:00Z' }); // 20:00 Kyiv
    const notion = await seed(env);
    const done = (await notion.queryTasks({ text: 'бюджет' }))[0]!;
    await notion.setTaskStatus(done.id, 'done');
    await notion.logDecision({ title: 'Запускаємо пілот', project: 'Alpha', owner: 'Іван', due: '2026-10-30' });
    const html = await buildEveningReport(env.s);
    for (const s of SECTIONS_EVENING) expect(html).toContain(s);
    expect(html).toMatch(/Завершено сьогодні<\/b>  ·  1\n<blockquote>✓ Скласти бюджет/);
    expect(html).toMatch(/Не завершено<\/b>  ·  1\n<blockquote><b>Beta<\/b>\n◦ Лист інвестору  <i>сьогодні<\/i>/);
    expect(html).toContain('Запускаємо пілот');
    expect(html).toContain('Іван');
  });
});

describe('scheduler', () => {
  it('sends the morning report once at the configured time, even after a restart in the window', async () => {
    const env = await makeEnv({ now: '2026-10-23T04:59:00Z' }); // 07:59 Kyiv
    env.llm.chat = async () => say('{}');
    const jobs = buildJobs().filter((j) => j.name === 'morning_report');
    expect(await tick(env.s, jobs)).toEqual([]);
    env.setNow('2026-10-23T05:00:30Z');
    expect(await tick(env.s, jobs)).toEqual(['morning_report']);
    expect(await tick(env.s, jobs)).toEqual([]); // not twice
    expect(env.notified).toHaveLength(1);
    env.setNow('2026-10-23T06:30:00Z'); // 09:30: window (2h) still open but already done today
    expect(await tick(env.s, jobs)).toEqual([]);
    env.setNow('2026-10-24T05:20:00Z'); // next day, started 20 min late (server was down)
    expect(await tick(env.s, jobs)).toEqual(['morning_report']);
  });

  it('follows a time changed by command and the DST switch of 25.10 (UTC+3 -> UTC+2)', async () => {
    const env = await makeEnv({ now: '2026-10-26T05:30:00Z', settings: { morningTime: '07:30' } });
    env.llm.chat = async () => say('{}');
    const jobs = buildJobs().filter((j) => j.name === 'morning_report');
    // 05:30Z is 07:30 Kyiv on 26.10 (winter time) - due now, was NOT due at 04:30Z
    env.setNow('2026-10-26T04:30:00Z');
    expect(await tick(env.s, jobs)).toEqual([]);
    env.setNow('2026-10-26T05:30:00Z');
    expect(await tick(env.s, jobs)).toEqual(['morning_report']);
  });

  it('claims a job once, retries failures up to 3 times, alerts the owner', async () => {
    const env = await makeEnv();
    expect(await claimJob(env.db, 'x', 'p1')).toBe(1);
    expect(await claimJob(env.db, 'x', 'p1')).toBeUndefined(); // already running

    const failing = { name: 'flaky', due: () => 'k', run: async () => { throw new Error('nope'); } };
    expect(await tick(env.s, [failing])).toEqual([]);
    expect((await env.db.query('SELECT status, attempts FROM job_runs WHERE job = $1', ['flaky'])).rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await tick(env.s, [failing])).toEqual([]); // too soon to retry
    await env.db.query(`UPDATE job_runs SET updated_at = now() - interval '5 minutes' WHERE job = 'flaky'`);
    await tick(env.s, [failing]);
    await env.db.query(`UPDATE job_runs SET updated_at = now() - interval '5 minutes' WHERE job = 'flaky'`);
    await tick(env.s, [failing]);
    expect((await env.db.query('SELECT attempts FROM job_runs WHERE job = $1', ['flaky'])).rows[0]!.attempts).toBe(3);
    expect(env.notified.some((m) => m.includes('flaky'))).toBe(true);
    await env.db.query(`UPDATE job_runs SET updated_at = now() - interval '5 minutes' WHERE job = 'flaky'`);
    await tick(env.s, [failing]);
    expect((await env.db.query('SELECT attempts FROM job_runs WHERE job = $1', ['flaky'])).rows[0]!.attempts).toBe(3); // gave up
  });
});

describe('events search', () => {
  const answer = `Ось підбірка:\n[{"title":"AI Summit","why":"Про AI","start":"2026-11-12","end":"2026-11-13","location":"Київ","price":"$300","url":"https://aisummit.example/2026/"},
   {"title":"Без посилання","why":"x","url":"not-a-url"},{"title":"AI Summit дубль","why":"x","start":"2026-11-12","url":"https://www.aisummit.example/2026"}]`;
  it('parses tolerant JSON, drops entries without a real link, dedupes across runs', async () => {
    const found = parseEvents(answer);
    expect(found.map((e) => e.title)).toEqual(['AI Summit', 'AI Summit дубль']);
    expect(parseEvents('нічого немає')).toEqual([]);
    const env = await makeEnv({ settings: { eventsTopics: ['AI'], eventsGeo: 'Європа' } });
    env.llm.searchAnswer = answer;
    const st = await env.s.settings.get();
    const first = await searchEvents({ db: env.db, llm: env.llm, settings: st, today: '2026-10-23' });
    expect(first.fresh).toHaveLength(1);
    const second = await searchEvents({ db: env.db, llm: env.llm, settings: st, today: '2026-10-30' });
    expect(second.fresh).toHaveLength(0);
    const text = formatEvents(first.fresh);
    expect(text).toContain('Вартість: $300');
    expect(text).toContain('https://aisummit.example/2026/');
    expect(text).toContain('перевірте');
    void filterNew;
  });
  it('weekly job runs only on the configured weekday and with topics set', async () => {
    const env = await makeEnv({ now: '2026-10-26T07:00:00Z', settings: { eventsTopics: ['AI'], eventsWeekday: 1, eventsTime: '09:00' } }); // Monday 09:00 Kyiv(+2)
    env.llm.searchAnswer = answer;
    const jobs = buildJobs().filter((j) => j.name === 'events_weekly');
    expect(await tick(env.s, jobs)).toEqual(['events_weekly']);
    expect(await tick(env.s, jobs)).toEqual([]);
    env.setNow('2026-10-27T07:00:00Z');
    expect(await tick(env.s, jobs)).toEqual([]);
  });
});

describe('social dynamics', () => {
  const snap = (followers: number, day: string): SocialData => ({
    platform: 'instagram', account: 'boss', takenAt: day, totals: { followers, posts: 10 }, period: { reach: 1200 }, periodDays: 7,
    posts: [{ title: 'Пост', url: 'https://i/1', metrics: { likes: 10 } }], unavailable: ['profile_views'],
  });
  it('diffs totals, prints only what the API gave, and shows what it refused', async () => {
    const env = await makeEnv();
    await saveSnapshot(env.db, snap(1000, '2026-10-16'), '2026-10-16');
    const cur = snap(1042, '2026-10-23');
    expect(diffTotals(snap(1000, 'x'), cur)).toEqual({ followers: 42, posts: 0 });
    const text = formatSocial(cur, snap(1000, 'x'), 7);
    expect(text).toContain('+42 за 7 дн.');
    expect(text).toContain('охоплення 1');
    expect(text).toContain('API не віддає: profile_views');
  });
  it('morning report shows the follower delta from stored snapshots', async () => {
    const env = await makeEnv();
    await seed(env);
    await saveSnapshot(env.db, snap(1000, '2026-10-16'), '2026-10-16');
    await saveSnapshot(env.db, snap(1042, '2026-10-23'), '2026-10-23');
    env.llm.chat = async () => say('{}');
    expect(await buildMorningReport(env.s)).toMatch(/Instagram: підписники <b>1[\s ]?042<\/b> \(\+42 за 7 дн\.\)/);
  });
});
