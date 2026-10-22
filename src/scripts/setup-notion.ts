/**
 * Stage 1 setup. Usage:
 *   npm run setup:notion -- --parent <page-id> --tasks <database-id> \
 *        [--projects "A,B,C"] [--expense "Таксі,Їжа"] [--income "Клієнт,Інше"]
 * Needs DATABASE_URL, ENCRYPTION_KEY(not used here), NOTION_TOKEN in env. Prints the mapping for review.
 */
import { parseArgs } from 'node:util';
import { createPgDb, migrate } from '../db/index.js';
import { NotionHttp } from '../notion/client.js';
import { setupNotion } from '../notion/setup.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../store/settings.js';

const { values } = parseArgs({
  options: {
    parent: { type: 'string' },
    tasks: { type: 'string' },
    projects: { type: 'string', default: '' },
    expense: { type: 'string', default: '' },
    income: { type: 'string', default: '' },
    currency: { type: 'string', default: 'USD' },
  },
});

const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

if (!values.parent || !values.tasks || !process.env.NOTION_TOKEN || !process.env.DATABASE_URL) {
  console.error('Need --parent, --tasks and env NOTION_TOKEN, DATABASE_URL');
  process.exit(1);
}

const db = createPgDb(process.env.DATABASE_URL);
await migrate(db);
const settings = new SettingsStore(db, DEFAULT_SETTINGS(process.env.DEFAULT_TIMEZONE ?? 'Europe/Kyiv'));
const api = new NotionHttp(process.env.NOTION_TOKEN, process.env.NOTION_VERSION);

const categories = { expense: list(values.expense), income: list(values.income) };
const { schema, projects } = await setupNotion(api, {
  parentPageId: values.parent,
  tasksDbId: values.tasks,
  projects: list(values.projects),
  categories,
  currency: values.currency ?? 'USD',
});
await settings.update({ notion: schema, projects, categories, currency: values.currency ?? 'USD' });
console.log(JSON.stringify({ projects, tasksMapping: schema.tasks }, null, 2));
console.log('Saved. Check the tasks mapping above (status values, project/due properties) and edit settings.notion in the DB if a guess is wrong.');
await db.close();
