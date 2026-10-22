import { DateTime } from 'luxon';
import type { Account } from './integrations/google-calendar.js';
import { errMsg } from './lib/log.js';
import { NotConnected, type Services } from './services.js';

/**
 * Everything that changes the owner's data runs here, and only after the owner pressed "Підтвердити"
 * (contract §2.5). Tools only create a pending action with a human-readable summary.
 */
export interface ActionPayloads {
  'task.create': { title: string; project?: string; due?: string; priority?: string; notes?: string };
  'task.update': { id: string; title?: string; project?: string; due?: string; priority?: string; notes?: string; label: string };
  'task.complete': { id: string; label: string };
  'task.reschedule': { id: string; label: string; due: string; start?: string; end?: string };
  'decision.log': { title: string; project?: string; owner?: string; due?: string; text?: string };
  'waiting.add': { title: string; project?: string; from?: string; due?: string };
  'waiting.resolve': { id: string; label: string };
  'calendar.create': { account: Account; title: string; start: string; end: string; description?: string; location?: string };
  'plan.apply': { account: Account; blocks: Array<{ taskId: string; title: string; start: string; end: string }> };
  'finance.record': { date: string; amount: number; currency: string; kind: 'expense' | 'income'; category: string; scope: 'personal' | 'project'; project?: string; note: string };
  'note.save': { title: string; project?: string; source: string; text: string; file?: { fileId: string; name: string; mime: string } };
}

export type ActionKind = keyof ActionPayloads;

type Executors = { [K in ActionKind]: (s: Services, p: ActionPayloads[K]) => Promise<string> };

const CAL_NAME: Record<Account, string> = { work: 'робочий', personal: 'особистий' };

const requireCalendar = (s: Services) => {
  if (!s.calendar) throw new NotConnected('Google Calendar не підключено');
  return s.calendar;
};

export const EXECUTORS: Executors = {
  async 'task.create'(s, p) {
    const t = await (await s.notion()).createTask(p);
    return `Задачу створено: «${t.title}»${t.project ? ` (${t.project})` : ''}${t.due ? `, дедлайн ${t.due.slice(0, 10)}` : ''}.`;
  },

  async 'task.update'(s, p) {
    const { id, label: _label, ...patch } = p;
    const t = await (await s.notion()).updateTask(id, patch);
    return `Задачу оновлено: «${t.title}».`;
  },

  async 'task.complete'(s, p) {
    const t = await (await s.notion()).setTaskStatus(p.id, 'done');
    return `Задачу завершено: «${t.title}».`;
  },

  async 'task.reschedule'(s, p) {
    const notion = await s.notion();
    const t = await notion.updateTask(p.id, { due: p.due });
    let extra = '';
    const { rows } = await s.db.query('SELECT account, event_id FROM task_events WHERE task_id = $1', [p.id]);
    const link = rows[0];
    if (link) {
      if (p.start && p.end) {
        await requireCalendar(s).patch(link.account, link.event_id, { start: p.start, end: p.end, timeZone: (await s.settings.get()).timezone });
        extra = ' Блок у календарі теж перенесено.';
      } else extra = ' Блок у календарі не змінено — вкажіть час, щоб перенести і його.';
    }
    return `Задачу «${t.title}» перенесено на ${p.due.slice(0, 16).replace('T', ' ')}.${extra}`;
  },

  async 'decision.log'(s, p) {
    const d = await (await s.notion()).logDecision(p);
    return `Рішення зафіксовано: «${d.title}».`;
  },

  async 'waiting.add'(s, p) {
    const w = await (await s.notion()).addWaiting(p);
    return `Додано до очікуваних відповідей: «${w.title}».`;
  },

  async 'waiting.resolve'(s, p) {
    await (await s.notion()).resolveWaiting(p.id);
    return `Відповідь отримано: «${p.label}».`;
  },

  async 'calendar.create'(s, p) {
    const tz = (await s.settings.get()).timezone;
    const ev = await requireCalendar(s).create(p.account, { title: p.title, start: p.start, end: p.end, timeZone: tz, description: p.description, location: p.location });
    return `Подію створено в календарі (${CAL_NAME[p.account]}): «${ev.title}».${ev.link ? ` ${ev.link}` : ''}`;
  },

  async 'plan.apply'(s, p) {
    const cal = requireCalendar(s);
    const tz = (await s.settings.get()).timezone;
    let n = 0;
    for (const b of p.blocks) {
      const ev = await cal.create(p.account, { title: `🎯 ${b.title}`, start: b.start, end: b.end, timeZone: tz });
      await s.db.query(
        `INSERT INTO task_events(task_id, account, event_id) VALUES ($1,$2,$3)
         ON CONFLICT (task_id) DO UPDATE SET account = EXCLUDED.account, event_id = EXCLUDED.event_id`,
        [b.taskId, p.account, ev.id],
      );
      n++;
    }
    return `План дня застосовано: ${n} блок(ів) у календарі (${CAL_NAME[p.account]}).`;
  },

  async 'finance.record'(s, p) {
    const e = await (await s.notion()).addFinance(p);
    return `Записано: ${e.kind === 'expense' ? '−' : '+'}${e.amount} ${e.currency}, ${e.category}${e.project ? `, ${e.project}` : ', особисте'}.`;
  },

  async 'note.save'(s, p) {
    const notion = await s.notion();
    let file: { data: Uint8Array; name: string; mime: string } | undefined;
    let downloadError: string | undefined;
    if (p.file) {
      try {
        if (!s.downloadFile) throw new Error('немає завантажувача файлів');
        file = { data: await s.downloadFile(p.file.fileId), name: p.file.name, mime: p.file.mime };
      } catch (e) {
        downloadError = errMsg(e);
      }
    }
    const today = DateTime.fromJSDate(s.clock(), { zone: (await s.settings.get()).timezone }).toISODate()!;
    const r = await notion.saveNote({ title: p.title, project: p.project, source: p.source, date: today, text: p.text, file });
    const fileNote = p.file ? (r.fileAttached ? ' Файл прикріплено.' : ` Файл не вдалося прикріпити (${r.fileError ?? downloadError}); текст збережено.`) : '';
    return `Збережено в «Матеріали»${p.project ? ` → ${p.project}` : ''}: «${p.title}».${fileNote}`;
  },
};

/** Confirm button: claim once (a double tap can't run it twice), execute, record the result. */
/** `claimed: false` = someone already handled it (double tap / other device): nothing ran. */
export async function runPending(s: Services, id: string): Promise<{ ok: boolean; text: string; claimed: boolean }> {
  const action = await s.pending.claim(id);
  if (!action) return { ok: false, text: 'Цю дію вже оброблено або вона застаріла.', claimed: false };
  const exec = EXECUTORS[action.kind as ActionKind] as ((s: Services, p: unknown) => Promise<string>) | undefined;
  if (!exec) {
    await s.pending.finish(id, 'failed', 'unknown kind');
    return { ok: false, text: `Невідомий тип дії: ${action.kind}`, claimed: true };
  }
  try {
    const text = await exec(s, action.payload);
    await s.pending.finish(id, 'done', text);
    return { ok: true, text, claimed: true };
  } catch (e) {
    const msg = errMsg(e);
    s.log.error('action_failed', { kind: action.kind, error: msg.slice(0, 300) });
    await s.pending.finish(id, 'failed', msg);
    return { ok: false, text: `Не вдалося виконати: ${msg}`, claimed: true };
  }
}
