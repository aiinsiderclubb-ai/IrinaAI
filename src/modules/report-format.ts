import { DateTime } from 'luxon';
import type { Task } from '../notion/repo.js';
import { esc } from '../services.js';

/**
 * Building blocks for the Telegram reports (HTML parse mode).
 * Lists live in blockquotes; long ones collapse (`expandable`) so a report stays one screen.
 * No blank lines inside a block: the bot splits long messages on blank lines and must not cut a tag.
 */

export const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

/** «12 жовт», «завтра», «прострочено 3 дн» relative to `today` (YYYY-MM-DD) */
export function dueLabel(due: string | undefined, today: string, zone: string): string {
  if (!due) return '';
  const d = DateTime.fromISO(due.slice(0, 10), { zone });
  const days = Math.round(d.diff(DateTime.fromISO(today, { zone }), 'days').days);
  const time = due.length > 10 ? ` ${DateTime.fromISO(due, { zone }).toFormat('HH:mm')}` : '';
  if (days < 0) return `прострочено ${-days} дн`;
  if (days === 0) return `сьогодні${time}`;
  if (days === 1) return `завтра${time}`;
  return d.setLocale('uk').toFormat(days < 7 ? 'ccc, d LLL' : 'd LLL') + time;
}

/** «MLI · Стратегія» with project MLI reads as «Стратегія»: the project is already the group heading. */
export function shortTitle(t: { title: string; project?: string }): string {
  const p = t.project?.trim();
  const rest = p && t.title.startsWith(`${p} · `) ? t.title.slice(p.length + 3).trim() : t.title;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function taskItem(t: Task, today: string, zone: string, opts: { project?: boolean } = {}): string {
  const due = dueLabel(t.due, today, zone);
  const project = opts.project && t.project ? ` <i>· ${esc(t.project)}</i>` : '';
  // overdue reads as «⏱ 12 дн»: the header already says these are late
  const when = due ? (due.startsWith('прострочено') ? `  <i>⏱ ${due.replace('прострочено ', '')}</i>` : `  <i>${due}</i>`) : '';
  return `${esc(shortTitle(t))}${project}${when}`;
}

/** Tasks grouped by project inside one quote; projects with more tasks first. */
export function groupedTasks(tasks: Task[], today: string, zone: string, max = 14): string {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.project?.trim() || 'Без проєкту';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const loose = (k: string) => (k === 'Без проєкту' ? 1 : 0);
  const ordered = [...groups.entries()].sort((a, b) => loose(a[0]) - loose(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const lines: string[] = [];
  let shown = 0;
  for (const [project, list] of ordered) {
    if (shown >= max) break;
    if (groups.size > 1 || project !== 'Без проєкту') lines.push(`<b>${esc(project)}</b>`);
    for (const t of list) {
      if (shown >= max) break;
      lines.push(`◦ ${taskItem(t, today, zone)}`);
      shown++;
    }
  }
  if (tasks.length > shown) lines.push(`<i>…і ще ${tasks.length - shown}</i>`);
  return quote(lines, shown > 5);
}

export function quote(lines: string[], expandable = false): string {
  return `<blockquote${expandable ? ' expandable' : ''}>${lines.join('\n')}</blockquote>`;
}

export function heading(icon: string, title: string, count?: number): string {
  return `${icon} <b>${esc(title)}</b>${count !== undefined && count > 0 ? `  ·  ${count}` : ''}`;
}

export const calm = (text: string) => `<i>${esc(text)}</i>`;

/** Sections with nothing to say collapse into one line at the end instead of a row of «немає». */
export class Sections {
  private parts: string[] = [];
  private quiet: string[] = [];
  add(head: string, body: string): void {
    this.parts.push(`${head}\n${body}`);
  }
  /** body undefined = nothing to report */
  maybe(head: string, name: string, body: string | undefined): void {
    if (body === undefined) this.quiet.push(name);
    else this.add(head, body);
  }
  raw(html: string): void {
    this.parts.push(html);
  }
  html(closing: string): string {
    const tail = this.quiet.length ? [`<i>Без новин: ${this.quiet.map(esc).join(', ')}.</i>`] : [];
    return [...this.parts, ...tail, closing].join('\n\n');
  }
}

export const RULE = '┈┈┈┈┈┈┈┈┈┈┈┈';

export function title(icon: string, text: string, date: DateTime): string {
  const day = date.setLocale('uk').toFormat('cccc, d MMMM');
  return `${icon} <b>${esc(text)}</b>\n<i>${esc(day)}</i>`;
}
