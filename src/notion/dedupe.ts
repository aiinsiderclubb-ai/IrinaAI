const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "Same task" test used before creating a task: exact, containment, or high token overlap. */
export function isDuplicateTitle(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length >= 10 && long.includes(short)) return true;
  const tx = new Set(x.split(' '));
  const ty = new Set(y.split(' '));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  const union = new Set([...tx, ...ty]).size;
  return union > 0 && inter / union >= 0.8;
}
