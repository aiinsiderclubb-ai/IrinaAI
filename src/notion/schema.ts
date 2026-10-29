/**
 * Mapping between the assistant's logical fields and the client's real Notion databases.
 * The client's structure is NOT reorganised (contract §A, Notion): we discover it and store the mapping.
 */

export type PropType =
  | 'title'
  | 'rich_text'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'number'
  | 'checkbox'
  | 'relation'
  | 'url'
  | 'people';

export interface PropRef {
  name: string;
  type: PropType;
  /** for `relation`: database the relation points to (used to resolve project names) */
  relationDb?: string;
}

export interface StatusRef extends PropRef {
  todo: string;
  doing?: string;
  done: string;
}

export interface TasksSchema {
  db: string;
  title: PropRef;
  project?: PropRef;
  status: StatusRef;
  due?: PropRef;
  priority?: PropRef;
  notes?: PropRef;
  /** area / category of work (e.g. «Напрям»: Стратегія, Продукт…) */
  area?: PropRef;
  /** who does it (e.g. «Відповідальний»: Founder, Dot, Claude…) */
  owner?: PropRef;
  /** link to the result / source */
  result?: PropRef;
  /** no project property: the project is the title prefix before « · » (e.g. «MLI · Стратегія …») */
  projectFromTitle?: boolean;
}

export interface DecisionsSchema {
  db: string;
  title: PropRef;
  project?: PropRef;
  owner?: PropRef;
  due?: PropRef;
  text?: PropRef;
}

export interface WaitingSchema {
  db: string;
  title: PropRef;
  project?: PropRef;
  from?: PropRef;
  due?: PropRef;
  status: PropRef & { open: string; done: string };
}

export interface FinanceSchema {
  db: string;
  /** the free-text note */
  title: PropRef;
  date: PropRef;
  amount: PropRef;
  currency: PropRef;
  kind: PropRef & { expense: string; income: string };
  category: PropRef;
  scope: PropRef & { personal: string; project: string };
  project?: PropRef;
}

export interface NotesSchema {
  db: string;
  title: PropRef;
  project?: PropRef;
  source?: PropRef;
  date?: PropRef;
}

export interface NotionSchema {
  tasks: TasksSchema;
  decisions?: DecisionsSchema;
  waiting?: WaitingSchema;
  finance?: FinanceSchema;
  notes?: NotesSchema;
}

/** Subset of the Notion `database` object we rely on. */
export interface NotionDatabaseMeta {
  id: string;
  properties: Record<string, { id: string; type: string; [k: string]: any }>;
}

const lc = (s: string) => s.toLowerCase();

function findProp(
  db: NotionDatabaseMeta,
  types: PropType[],
  names: RegExp,
  used: Set<string>,
): PropRef | undefined {
  const entries = Object.entries(db.properties).filter(([n, p]) => !used.has(n) && (types as string[]).includes(p.type));
  const byName = entries.find(([n]) => names.test(lc(n)));
  const hit = byName ?? undefined;
  if (!hit) return undefined;
  used.add(hit[0]);
  const ref: PropRef = { name: hit[0], type: hit[1].type as PropType };
  if (hit[1].type === 'relation') ref.relationDb = hit[1].relation?.database_id;
  return ref;
}

function optionNames(db: NotionDatabaseMeta, ref: PropRef): string[] {
  const p = db.properties[ref.name];
  if (!p) return [];
  if (ref.type === 'status') return (p.status?.options ?? []).map((o: any) => o.name);
  if (ref.type === 'select') return (p.select?.options ?? []).map((o: any) => o.name);
  return [];
}

function pickOption(options: string[], re: RegExp, fallback: string): string {
  return options.find((o) => re.test(lc(o))) ?? fallback;
}

/**
 * Best-effort guess of the mapping for the client's existing tasks database.
 * The result is shown to the operator at setup (Stage 1) and can be corrected by hand.
 */
export function discoverTasksSchema(db: NotionDatabaseMeta): TasksSchema {
  const titleEntry = Object.entries(db.properties).find(([, p]) => p.type === 'title');
  if (!titleEntry) throw new Error('Tasks database has no title property');
  const used = new Set<string>([titleEntry[0]]);
  const title: PropRef = { name: titleEntry[0], type: 'title' };

  const status =
    findProp(db, ['status', 'select', 'checkbox'], /status|статус|стан|state|done|готов/, used) ??
    (() => {
      throw new Error('Tasks database has no status/select/checkbox property named like "Status"');
    })();
  const options = optionNames(db, status);
  const statusRef: StatusRef = {
    ...status,
    todo: pickOption(options, /not started|to.?do|backlog|нов|до викон|не розпоч|заплан/, options[0] ?? 'To do'),
    doing: options.find((o) => /progress|doing|в роботі|у роботі|в процес/.test(lc(o))),
    done: pickOption(options, /^done$|complete|готов|викон|заверш|закрит|зроблен/, options[options.length - 1] ?? 'Done'),
  };

  const schema = {
    db: db.id,
    title,
    status: statusRef,
    project: findProp(db, ['relation', 'select', 'multi_select', 'rich_text'], /project|проєкт|проект/, used),
    due: findProp(db, ['date'], /due|deadline|дедлайн|термін|строк|date|дата/, used),
    priority: findProp(db, ['select', 'status', 'number'], /priority|пріоритет|приоритет/, used),
    notes: findProp(db, ['rich_text'], /note|notes|опис|нотатк|примітк|коментар|description/, used),
    area: findProp(db, ['select', 'multi_select'], /напрям|категор|area|category|тип|type/, used),
    owner: findProp(db, ['select', 'people', 'rich_text'] as PropType[], /відповідал|виконав|owner|assignee|хто/, used),
    result: findProp(db, ['url'], /результат|джерело|result|link|посилан/, used),
  } as TasksSchema;
  if (!schema.project) schema.projectFromTitle = true;
  return schema;
}

/** Project names the client already uses (select options or titles of the relation DB are resolved elsewhere). */
export function projectOptions(db: NotionDatabaseMeta, ref?: PropRef): string[] {
  if (!ref) return [];
  const p = db.properties[ref.name];
  if (!p) return [];
  if (ref.type === 'select') return (p.select?.options ?? []).map((o: any) => o.name);
  if (ref.type === 'multi_select') return (p.multi_select?.options ?? []).map((o: any) => o.name);
  return [];
}
