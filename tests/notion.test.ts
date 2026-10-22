import { describe, expect, it } from 'vitest';
import { NotionRepo } from '../src/notion/repo.js';
import { discoverTasksSchema, type NotionDatabaseMeta, type NotionSchema } from '../src/notion/schema.js';
import { setupNotion } from '../src/notion/setup.js';
import { FakeNotion, TEST_SCHEMA } from '../src/dev/fakeNotion.js';

describe('schema discovery', () => {
  const db: NotionDatabaseMeta = {
    id: 'db1',
    properties: {
      Завдання: { id: 'a', type: 'title' },
      Статус: { id: 'b', type: 'status', status: { options: [{ name: 'Не розпочато' }, { name: 'В роботі' }, { name: 'Готово' }] } },
      Проєкт: { id: 'c', type: 'relation', relation: { database_id: 'projects-db' } },
      Дедлайн: { id: 'd', type: 'date' },
      Пріоритет: { id: 'e', type: 'select', select: { options: [] } },
      Нотатки: { id: 'f', type: 'rich_text' },
    },
  };
  it('maps a Ukrainian-named tasks database', () => {
    const s = discoverTasksSchema(db);
    expect(s.title.name).toBe('Завдання');
    expect(s.status).toMatchObject({ name: 'Статус', type: 'status', todo: 'Не розпочато', doing: 'В роботі', done: 'Готово' });
    expect(s.project).toEqual({ name: 'Проєкт', type: 'relation', relationDb: 'projects-db' });
    expect(s.due?.name).toBe('Дедлайн');
    expect(s.priority?.name).toBe('Пріоритет');
    expect(s.notes?.name).toBe('Нотатки');
  });
  it('fails loudly when there is no status-like property', () => {
    expect(() => discoverTasksSchema({ id: 'x', properties: { Name: { id: '1', type: 'title' } } })).toThrow(/status/i);
  });
});

describe('setupNotion', () => {
  it('creates the four supporting databases and returns a usable mapping', async () => {
    const created: string[] = [];
    const api = {
      async request(method: string, path: string, body?: any) {
        if (method === 'GET') return { id: 'tasks-db', properties: { Name: { id: '1', type: 'title' }, Status: { id: '2', type: 'status', status: { options: [{ name: 'To do' }, { name: 'Done' }] } }, Project: { id: '3', type: 'select', select: { options: [{ name: 'Alpha' }] } } } };
        created.push(body.title[0].text.content);
        return { id: `db-${created.length}` };
      },
      async upload() { return 'x'; },
    };
    const { schema, projects } = await setupNotion(api as never, { parentPageId: 'p', tasksDbId: 'tasks-db', projects: [], categories: { expense: ['Таксі'], income: [] }, currency: 'USD' });
    expect(projects).toEqual(['Alpha']);
    expect(created).toHaveLength(4);
    expect(schema.finance?.db).toBe('db-3');
    expect(schema.tasks.status.done).toBe('Done');
  });
});

describe('NotionRepo', () => {
  const repoWith = (schema: NotionSchema = TEST_SCHEMA) => {
    const api = new FakeNotion();
    return { api, repo: new NotionRepo(api, schema) };
  };

  it('creates a task and reads it back; open filter hides done ones', async () => {
    const { repo } = repoWith();
    const a = await repo.createTask({ title: 'Надіслати договір', project: 'Alpha', due: '2026-10-24', priority: 'High', notes: 'до обіду' });
    expect(a).toMatchObject({ title: 'Надіслати договір', project: 'Alpha', due: '2026-10-24', status: 'Not started', done: false, priority: 'High', notes: 'до обіду' });
    await repo.setTaskStatus(a.id, 'done');
    expect((await repo.queryTasks({ open: true })).map((t) => t.id)).not.toContain(a.id);
    expect((await repo.getTask(a.id)).done).toBe(true);
  });

  it('finds a duplicate among open tasks of the same project only', async () => {
    const { repo } = repoWith();
    await repo.createTask({ title: 'Підготувати презентацію', project: 'Alpha' });
    expect(await repo.findDuplicate('підготувати презентацію!', 'Alpha')).toBeTruthy();
    expect(await repo.findDuplicate('підготувати презентацію', 'Beta')).toBeUndefined();
  });

  it('completed tasks are not duplicates (a finished task can be created again)', async () => {
    const { repo } = repoWith();
    const t = await repo.createTask({ title: 'Оплатити рахунок', project: 'Alpha' });
    await repo.setTaskStatus(t.id, 'done');
    expect(await repo.findDuplicate('Оплатити рахунок', 'Alpha')).toBeUndefined();
  });

  it('supports relation projects and checkbox status', async () => {
    const api = new FakeNotion();
    const alpha = api.seed('projects', { Name: { title: [{ text: { content: 'Alpha' } }] } });
    const schema: NotionSchema = {
      tasks: {
        db: 'tasks',
        title: { name: 'Name', type: 'title' },
        project: { name: 'Project', type: 'relation', relationDb: 'projects' },
        status: { name: 'Done', type: 'checkbox', todo: 'todo', done: 'done' },
      },
    };
    const repo = new NotionRepo(api, schema);
    const t = await repo.createTask({ title: 'Зателефонувати', project: 'alpha' });
    expect(t).toMatchObject({ project: 'Alpha', done: false });
    expect((await repo.queryTasks({ project: 'Alpha', open: true })).map((x) => x.id)).toEqual([t.id]);
    expect((await repo.setTaskStatus(t.id, 'done')).done).toBe(true);
    expect(await repo.queryTasks({ open: true })).toHaveLength(0);
    await expect(repo.createTask({ title: 'x', project: 'Nope' })).rejects.toThrow(/Alpha/);
    void alpha;
  });

  it('saves a note with attached file, and survives a failing upload', async () => {
    const { api, repo } = repoWith();
    const ok = await repo.saveNote({ title: 'GPT: стратегія', project: 'Alpha', source: 'ChatGPT', text: 'Абзац 1\n\nАбзац 2', file: { data: new Uint8Array([1]), name: 'a.pdf', mime: 'application/pdf' } });
    expect(ok.fileAttached).toBe(true);
    expect(api.uploads).toEqual(['a.pdf']);
    api.upload = async () => { throw new Error('boom'); };
    const bad = await repo.saveNote({ title: 'x', text: 'y', file: { data: new Uint8Array([1]), name: 'b.pdf', mime: 'application/pdf' } });
    expect(bad).toMatchObject({ fileAttached: false, fileError: 'boom' });
  });

  it('writes and queries finance rows by period', async () => {
    const { repo } = repoWith();
    await repo.addFinance({ date: '2026-10-20', amount: 45, currency: 'USD', kind: 'expense', category: 'Таксі', scope: 'personal', note: 'taxi' });
    await repo.addFinance({ date: '2026-10-25', amount: 900, currency: 'USD', kind: 'income', category: 'Клієнт', scope: 'project', project: 'Alpha', note: '' });
    const rows = await repo.queryFinance('2026-10-01', '2026-10-22');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 45, kind: 'expense', scope: 'personal', category: 'Таксі' });
    expect((await repo.queryFinance('2026-10-01', '2026-10-31')).find((r) => r.kind === 'income')).toMatchObject({ project: 'Alpha', scope: 'project' });
  });
});
