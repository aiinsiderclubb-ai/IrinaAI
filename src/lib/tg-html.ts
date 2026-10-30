/**
 * The model writes light Markdown (**bold**, lists, `code`, links). Telegram shows it raw,
 * so replies are converted to Telegram HTML: escape first, then turn the marks into tags.
 */

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(line: string): string {
  const codes: string[] = [];
  let out = escHtml(line).replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
    .replace(/(^|[\s(«])\*([^*\s][^*\n]*?)\*(?=$|[\s.,!?:;)»])/g, '$1<i>$2</i>')
    .replace(/(^|[\s(«])_([^_\s][^_\n]*?)_(?=$|[\s.,!?:;)»])/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

export function mdToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string[] | undefined;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (fence) {
        out.push(`<pre>${escHtml(fence.join('\n'))}</pre>`);
        fence = undefined;
      } else fence = [];
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push(`<b>${inline(heading[1]!)}</b>`);
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(raw)) {
      out.push('┈┈┈┈┈┈┈┈┈┈┈┈');
      continue;
    }
    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
      continue;
    }
    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]!.length >= 2 ? '   ◦' : '•'} ${inline(bullet[2]!)}`);
      continue;
    }
    out.push(inline(raw));
  }
  if (fence) out.push(`<pre>${escHtml(fence.join('\n'))}</pre>`);
  // neighbouring quote lines become one quote
  return out.join('\n').replace(/<\/blockquote>\n<blockquote>/g, '\n');
}

/** Plain text for a fallback when Telegram rejects the HTML. */
export function stripMd(md: string): string {
  return md.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/`([^`]+)`/g, '$1');
}
