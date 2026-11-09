/**
 * The assistant writes documents in light Markdown; Notion wants blocks.
 * Supported: # headings, paragraphs, - bullets, 1. numbers, - [ ] to-dos, > quotes, ---, | tables |, **bold**, *italic*.
 */

const MAX_TEXT = 1900; // Notion caps one rich_text item at 2000 characters

type Rich = { type: 'text'; text: { content: string }; annotations?: { bold?: boolean; italic?: boolean; code?: boolean } };

/** **bold**, *italic*, `code` -> annotated rich_text pieces */
export function richText(line: string): Rich[] {
  const out: Rich[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;
  let last = 0;
  const push = (content: string, annotations?: Rich['annotations']) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      const piece: Rich = { type: 'text', text: { content: content.slice(i, i + MAX_TEXT) } };
      if (annotations) piece.annotations = annotations;
      out.push(piece);
    }
  };
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) push(line.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], { bold: true });
    else if (m[2] !== undefined) push(m[2], { code: true });
    else push(m[3]!, { italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) push(line.slice(last));
  return out;
}

const block = (type: string, body: Record<string, unknown>) => ({ object: 'block', type, [type]: body });

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isTableRule = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row);

export function mdToBlocks(md: string): any[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    // a table: header row, |---|---| rule, rows
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [head];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      i--;
      const width = Math.max(...rows.map((r) => r.length));
      out.push(
        block('table', {
          table_width: width,
          has_column_header: true,
          has_row_header: false,
          children: rows.map((r) => block('table_row', { cells: Array.from({ length: width }, (_, k) => richText(r[k] ?? '')) })),
        }),
      );
      continue;
    }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/);
    if (h) {
      out.push(block(`heading_${Math.min(h[1]!.length, 3)}`, { rich_text: richText(h[2]!) }));
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      out.push(block('divider', {}));
      continue;
    }
    const todo = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/);
    if (todo) {
      out.push(block('to_do', { rich_text: richText(todo[2]!), checked: todo[1] !== ' ' }));
      continue;
    }
    const bullet = line.match(/^\s*[-*+•]\s+(.*)$/);
    if (bullet) {
      out.push(block('bulleted_list_item', { rich_text: richText(bullet[1]!) }));
      continue;
    }
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (num) {
      out.push(block('numbered_list_item', { rich_text: richText(num[1]!) }));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(block('quote', { rich_text: richText(quote[1]!) }));
      continue;
    }
    out.push(block('paragraph', { rich_text: richText(line.trim()) }));
  }
  return out;
}
