import type { PropRef } from './schema.js';

const text = (arr: any[] | undefined): string => (arr ?? []).map((t) => t.plain_text ?? '').join('');

/** Notion property value (from a page) -> plain JS value. */
export function readProp(ref: PropRef | undefined, page: any): any {
  if (!ref) return undefined;
  const p = page?.properties?.[ref.name];
  if (!p) return undefined;
  switch (ref.type) {
    case 'title':
      return text(p.title);
    case 'rich_text':
      return text(p.rich_text);
    case 'select':
      return p.select?.name ?? undefined;
    case 'status':
      return p.status?.name ?? undefined;
    case 'multi_select':
      return (p.multi_select ?? []).map((o: any) => o.name);
    case 'date':
      return p.date ? { start: p.date.start as string, end: (p.date.end as string | null) ?? undefined } : undefined;
    case 'number':
      return p.number ?? undefined;
    case 'checkbox':
      return Boolean(p.checkbox);
    case 'relation':
      return (p.relation ?? []).map((r: any) => r.id as string);
    case 'url':
      return p.url ?? undefined;
  }
}

const rich = (s: string) => {
  // Notion limits one text object to 2000 chars
  const chunks = s.match(/[\s\S]{1,1900}/g) ?? [''];
  return chunks.map((c) => ({ type: 'text', text: { content: c } }));
};

/** Plain JS value -> Notion property payload (for create/update). */
export function writeProp(ref: PropRef, value: unknown): any {
  switch (ref.type) {
    case 'title':
      return { title: rich(String(value)) };
    case 'rich_text':
      return { rich_text: rich(String(value)) };
    case 'select':
      return { select: value ? { name: String(value) } : null };
    case 'status':
      return { status: { name: String(value) } };
    case 'multi_select':
      return { multi_select: (Array.isArray(value) ? value : [value]).filter(Boolean).map((n) => ({ name: String(n) })) };
    case 'date':
      return { date: value ? (typeof value === 'string' ? { start: value } : value) : null };
    case 'number':
      return { number: value === null || value === undefined ? null : Number(value) };
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'relation':
      return { relation: (value as string[]).map((id) => ({ id })) };
    case 'url':
      return { url: value ? String(value) : null };
  }
}

/** Filter fragment "property equals/contains value". */
export function matchFilter(ref: PropRef, value: string | string[]): any {
  const v = Array.isArray(value) ? value[0]! : value;
  switch (ref.type) {
    case 'select':
      return { property: ref.name, select: { equals: v } };
    case 'status':
      return { property: ref.name, status: { equals: v } };
    case 'multi_select':
      return { property: ref.name, multi_select: { contains: v } };
    case 'rich_text':
      return { property: ref.name, rich_text: { contains: v } };
    case 'title':
      return { property: ref.name, title: { contains: v } };
    case 'relation':
      return { property: ref.name, relation: { contains: v } };
    default:
      throw new Error(`Cannot filter by property type ${ref.type}`);
  }
}

export function notEqualFilter(ref: PropRef, value: string): any {
  switch (ref.type) {
    case 'status':
      return { property: ref.name, status: { does_not_equal: value } };
    case 'select':
      return { property: ref.name, select: { does_not_equal: value } };
    case 'checkbox':
      return { property: ref.name, checkbox: { equals: false } };
    default:
      throw new Error(`Cannot filter by property type ${ref.type}`);
  }
}
