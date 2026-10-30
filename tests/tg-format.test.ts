import { describe, expect, it } from 'vitest';
import { mdToTelegramHtml } from '../src/lib/tg-html.js';
import { dueLabel, groupedTasks, shortTitle } from '../src/modules/report-format.js';

describe('Markdown → Telegram HTML', () => {
  it('turns the model marks into tags and escapes everything else', () => {
    const md = '### План\nПрийняла: **Оновлення Notion не виконане**, див. *Опції*.\n- перша <b>\n  - вкладена\n`id_1` і [Notion](https://notion.so/x?a=1&b=2)';
    expect(mdToTelegramHtml(md)).toBe(
      '<b>План</b>\nПрийняла: <b>Оновлення Notion не виконане</b>, див. <i>Опції</i>.\n• перша &lt;b&gt;\n   ◦ вкладена\n<code>id_1</code> і <a href="https://notion.so/x?a=1&amp;b=2">Notion</a>',
    );
  });

  it('leaves snake_case, math and lone stars alone', () => {
    expect(mdToTelegramHtml('task_id_2 і 2*3*4, ціна 5 * 2')).toBe('task_id_2 і 2*3*4, ціна 5 * 2');
  });

  it('keeps code blocks verbatim and joins quote lines', () => {
    expect(mdToTelegramHtml('```\n**не жирний** <x>\n```\n> раз\n> два')).toBe('<pre>**не жирний** &lt;x&gt;</pre>\n<blockquote>раз\nдва</blockquote>');
  });
});

describe('report building blocks', () => {
  const zone = 'Europe/Kyiv';
  it('says due dates the human way', () => {
    expect(dueLabel('2026-10-12', '2026-10-30', zone)).toBe('прострочено 18 дн');
    expect(dueLabel('2026-10-30', '2026-10-30', zone)).toBe('сьогодні');
    expect(dueLabel('2026-10-31T14:00:00+02:00', '2026-10-30', zone)).toBe('завтра 14:00');
    expect(dueLabel('2026-11-20', '2026-10-30', zone)).toBe('20 лист.');
  });

  it('drops the project prefix from titles and groups by project, loose tasks last', () => {
    expect(shortTitle({ title: 'MLI · обрати стратега', project: 'MLI' })).toBe('Обрати стратега');
    const t = (title: string, project?: string) => ({ id: title, title, project, status: '', done: false, due: '2026-10-20' });
    const html = groupedTasks([t('Без групи'), t('MLI · A', 'MLI'), t('MLI · B', 'MLI'), t('Інше', 'Beta')], '2026-10-30', zone);
    expect(html).toBe('<blockquote><b>MLI</b>\n◦ A  <i>⏱ 10 дн</i>\n◦ B  <i>⏱ 10 дн</i>\n<b>Beta</b>\n◦ Інше  <i>⏱ 10 дн</i>\n<b>Без проєкту</b>\n◦ Без групи  <i>⏱ 10 дн</i></blockquote>');
  });
});
