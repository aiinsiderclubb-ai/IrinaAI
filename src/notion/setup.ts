import type { NotionApi } from './client.js';
import {
  discoverTasksSchema,
  projectOptions,
  type DecisionsSchema,
  type FinanceSchema,
  type NotesSchema,
  type NotionDatabaseMeta,
  type NotionSchema,
  type WaitingSchema,
} from './schema.js';

const t = (name: string) => [{ type: 'text', text: { content: name } }];
const options = (names: string[]) => names.map((name) => ({ name }));

async function createDb(api: NotionApi, parentPageId: string, title: string, properties: Record<string, unknown>): Promise<string> {
  const res = await api.request<{ id: string }>('POST', '/v1/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: t(title),
    properties,
  });
  return res.id;
}

export interface SetupInput {
  parentPageId: string;
  tasksDbId: string;
  projects: string[];
  categories: { expense: string[]; income: string[] };
  currency: string;
}

/**
 * Stage 1: maps the client's existing tasks DB and creates the supporting databases
 * (decisions, expected replies, finance, materials) next to it. Does not touch existing data.
 */
export async function setupNotion(api: NotionApi, input: SetupInput): Promise<{ schema: NotionSchema; projects: string[] }> {
  const tasksMeta = await api.request<NotionDatabaseMeta>('GET', `/v1/databases/${input.tasksDbId}`);
  const tasks = discoverTasksSchema(tasksMeta);
  const projects = input.projects.length ? input.projects : projectOptions(tasksMeta, tasks.project);
  const projectSelect = { select: { options: options(projects) } };

  const decisionsDb = await createDb(api, input.parentPageId, 'Рішення та домовленості', {
    Name: { title: {} },
    Project: projectSelect,
    Owner: { rich_text: {} },
    Due: { date: {} },
    Details: { rich_text: {} },
  });
  const decisions: DecisionsSchema = {
    db: decisionsDb,
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    owner: { name: 'Owner', type: 'rich_text' },
    due: { name: 'Due', type: 'date' },
    text: { name: 'Details', type: 'rich_text' },
  };

  const waitingDb = await createDb(api, input.parentPageId, 'Очікую відповідь', {
    Name: { title: {} },
    Project: projectSelect,
    From: { rich_text: {} },
    Due: { date: {} },
    Status: { select: { options: options(['Очікую', 'Отримано']) } },
  });
  const waiting: WaitingSchema = {
    db: waitingDb,
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    from: { name: 'From', type: 'rich_text' },
    due: { name: 'Due', type: 'date' },
    status: { name: 'Status', type: 'select', open: 'Очікую', done: 'Отримано' },
  };

  const financeDb = await createDb(api, input.parentPageId, 'Фінанси', {
    Note: { title: {} },
    Date: { date: {} },
    Amount: { number: { format: 'number' } },
    Currency: { select: { options: options([input.currency]) } },
    Kind: { select: { options: options(['Витрата', 'Дохід']) } },
    Category: { select: { options: options([...input.categories.expense, ...input.categories.income]) } },
    Scope: { select: { options: options(['Особисте', 'Проєкт']) } },
    Project: projectSelect,
  });
  const finance: FinanceSchema = {
    db: financeDb,
    title: { name: 'Note', type: 'title' },
    date: { name: 'Date', type: 'date' },
    amount: { name: 'Amount', type: 'number' },
    currency: { name: 'Currency', type: 'select' },
    kind: { name: 'Kind', type: 'select', expense: 'Витрата', income: 'Дохід' },
    category: { name: 'Category', type: 'select' },
    scope: { name: 'Scope', type: 'select', personal: 'Особисте', project: 'Проєкт' },
    project: { name: 'Project', type: 'select' },
  };

  const notesDb = await createDb(api, input.parentPageId, 'Матеріали (ChatGPT, Dot)', {
    Name: { title: {} },
    Project: projectSelect,
    Source: { select: { options: options(['ChatGPT', 'Dot', 'Інше']) } },
    Date: { date: {} },
  });
  const notes: NotesSchema = {
    db: notesDb,
    title: { name: 'Name', type: 'title' },
    project: { name: 'Project', type: 'select' },
    source: { name: 'Source', type: 'select' },
    date: { name: 'Date', type: 'date' },
  };

  return { schema: { tasks, decisions, waiting, finance, notes }, projects };
}
