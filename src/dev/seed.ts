import { DateTime } from 'luxon';
import type { Db } from '../db/index.js';
import { saveSnapshot } from '../modules/social.js';
import { NotionRepo } from '../notion/repo.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../store/settings.js';
import { TokenStore } from '../store/tokens.js';
import { FakeCalendar } from './fakeCalendar.js';
import { FakeNotion, TEST_SCHEMA } from './fakeNotion.js';

/** Sample founder's week (tasks, expected replies, finance, two calendars, social) for the demo and the eval. */
export async function seedDemo(db: Db, encryptionKey: string, zone: string) {
  const settings = new SettingsStore(db, DEFAULT_SETTINGS(zone));
  await settings.update({
    notion: TEST_SCHEMA,
    projects: ['Запуск продукту', 'Інвестори', 'Команда'],
    categories: { expense: ['Таксі', 'Їжа', 'Сервіси', 'Подорожі'], income: ['Клієнт', 'Інше'] },
    eventsTopics: ['AI у бізнесі', 'Фінтех'],
    eventsGeo: 'Європа, онлайн',
  });
  const tokens = new TokenStore(db, encryptionKey);
  await tokens.save('google:work', { refreshToken: 'demo', meta: {} });
  await tokens.save('google:personal', { refreshToken: 'demo', meta: {} });

  // ---------- sample data ----------
  const now = DateTime.now().setZone(zone);
  const day = (d: number) => now.plus({ days: d }).toISODate()!;
  const at = (hhmm: string, d = 0) => DateTime.fromISO(`${day(d)}T${hhmm}`, { zone: zone }).toISO()!;
  const notionApi = new FakeNotion();
  const repo = new NotionRepo(notionApi, TEST_SCHEMA);
  for (const [title, project, due, priority] of [
    ['Підготувати презентацію для інвесторів', 'Інвестори', day(0), 'High'],
    ['Погодити бюджет маркетингу', 'Запуск продукту', day(0), 'Medium'],
    ['Відповісти юристу щодо договору', 'Запуск продукту', day(-1), 'High'],
    ['1:1 з новим дизайнером — підготувати питання', 'Команда', day(0), undefined],
    ['Фінальна версія лендингу', 'Запуск продукту', day(2), 'Medium'],
    ['Звіт для фонду за жовтень', 'Інвестори', day(4), 'High'],
    ['Оновити оргструктуру', 'Команда', day(6), 'Low'],
  ] as const) await repo.createTask({ title, project, due, priority });
  const doneTask = await repo.createTask({ title: 'Надіслати рахунок клієнту', project: 'Запуск продукту', due: day(0) });
  await repo.setTaskStatus(doneTask.id, 'done');
  await repo.addWaiting({ title: 'Підписаний NDA', from: 'Олена (юрист)', project: 'Запуск продукту', due: day(1) });
  await repo.addWaiting({ title: 'Фідбек на презентацію', from: 'Андрій (фонд)', project: 'Інвестори', due: day(3) });
  await repo.logDecision({ title: 'Запуск бета-версії переносимо на 15 листопада', project: 'Запуск продукту', owner: 'Ірина', due: day(24) });
  for (const [d, amount, kind, category, scope, project, note] of [
    [-6, 18, 'expense', 'Таксі', 'personal', undefined, 'аеропорт'],
    [-5, 42.5, 'expense', 'Їжа', 'personal', undefined, 'вечеря'],
    [-4, 129, 'expense', 'Сервіси', 'project', 'Запуск продукту', 'хостинг і домени'],
    [-3, 2400, 'income', 'Клієнт', 'project', 'Запуск продукту', 'передоплата'],
    [-2, 12, 'expense', 'Таксі', 'personal', undefined, ''],
    [-1, 310, 'expense', 'Подорожі', 'project', 'Інвестори', 'квитки на зустріч'],
  ] as const)
    await repo.addFinance({ date: day(d), amount, currency: 'USD', kind, category, scope, project, note });

  const calendar = new FakeCalendar();
  calendar.add('work', { title: 'Стендап команди', start: at('09:30'), end: at('10:00') });
  calendar.add('work', { title: 'Зустріч з фондом', start: at('11:00'), end: at('12:00'), location: 'Zoom' });
  calendar.add('personal', { title: 'Стоматолог', start: at('11:30'), end: at('12:15') });
  calendar.add('work', { title: 'Рев’ю дизайну лендингу', start: at('15:00'), end: at('16:00') });
  calendar.add('personal', { title: 'Тренування', start: at('19:00'), end: at('20:00') });
  calendar.add('work', { title: 'Планування спринту', start: at('10:00', 1), end: at('11:30', 1) });

  for (const [d, followers, reach] of [[-7, 4810, 9100], [0, 4932, 11240]] as const)
    await saveSnapshot(db, { platform: 'instagram', account: 'demo.founder', takenAt: now.plus({ days: d }).toISO()!, totals: { followers, following: 312, posts: 148 }, period: { reach, views: reach * 2, accounts_engaged: 640, total_interactions: 1320 }, periodDays: 7, posts: [{ title: 'Як ми зібрали команду за 30 днів', url: 'https://instagram.com/p/demo', metrics: { likes: 412, comments: 38, reach: 5200 } }], unavailable: ['profile_views'] }, day(d));
  await saveSnapshot(db, { platform: 'youtube', account: 'Demo Founder', takenAt: now.toISO()!, totals: { subscribers: 1280, views: 86400, videos: 42 }, period: { views: 3900, estimatedMinutesWatched: 11200, subscribersGained: 36, subscribersLost: 4 }, periodDays: 7, posts: [{ title: 'Інтерв’ю: як ми тестуємо гіпотези', url: 'https://youtu.be/demo', metrics: { views: 1840, likes: 96, comments: 12 } }], unavailable: [] }, day(0));
  return { settings, tokens, repo, calendar, notionApi };
}
