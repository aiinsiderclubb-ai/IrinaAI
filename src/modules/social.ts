import { DateTime } from 'luxon';
import type { Db } from '../db/index.js';
import type { SocialData } from '../integrations/social-types.js';

export const LABELS: Record<string, string> = {
  followers: 'підписники',
  following: 'підписки',
  posts: 'публікації',
  subscribers: 'підписники',
  views: 'перегляди',
  videos: 'відео',
  reach: 'охоплення',
  accounts_engaged: 'залучені акаунти',
  total_interactions: 'взаємодії',
  profile_views: 'перегляди профілю',
  estimatedMinutesWatched: 'хвилин перегляду',
  averageViewDuration: 'сер. тривалість перегляду, с',
  subscribersGained: 'нових підписників',
  subscribersLost: 'відписалось',
  likes: 'лайки',
  comments: 'коментарі',
  saved: 'збереження',
  shares: 'поширення',
};

const label = (k: string) => LABELS[k] ?? k;
const num = (n: number) => n.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n));

export async function saveSnapshot(db: Db, data: SocialData, day: string): Promise<void> {
  await db.query(
    `INSERT INTO social_snapshots(platform, taken_on, data) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (platform, taken_on) DO UPDATE SET data = EXCLUDED.data`,
    [data.platform, day, JSON.stringify(data)],
  );
}

/** Latest snapshot taken on or before `day` - n days (for dynamics). */
export async function snapshotAround(db: Db, platform: string, day: string, daysBack: number): Promise<SocialData | undefined> {
  const target = DateTime.fromISO(day).minus({ days: daysBack }).toISODate()!;
  const { rows } = await db.query<{ data: SocialData }>(
    `SELECT data FROM social_snapshots WHERE platform = $1 AND taken_on <= $2 ORDER BY taken_on DESC LIMIT 1`,
    [platform, target],
  );
  return rows[0]?.data;
}

/** Totals delta between two snapshots (followers/subscribers/views growth). */
export function diffTotals(prev: SocialData | undefined, cur: SocialData): Record<string, number> {
  if (!prev) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur.totals)) {
    const p = prev.totals[k];
    if (p !== undefined) out[k] = v - p;
  }
  return out;
}

export function formatSocial(cur: SocialData, prev?: SocialData, prevDays?: number): string {
  const name = cur.platform === 'instagram' ? 'Instagram' : 'YouTube';
  const delta = diffTotals(prev, cur);
  const lines = [`${name} @${cur.account}`];
  lines.push(
    'Всього: ' +
      Object.entries(cur.totals)
        .map(([k, v]) => `${label(k)} ${num(v)}${delta[k] !== undefined && delta[k] !== 0 ? ` (${signed(delta[k]!)} за ${prevDays} дн.)` : ''}`)
        .join(', '),
  );
  const period = Object.entries(cur.period);
  if (period.length) lines.push(`За ${cur.periodDays} дн.: ` + period.map(([k, v]) => `${label(k)} ${num(v)}`).join(', '));
  if (cur.unavailable.length) lines.push(`API не віддає: ${cur.unavailable.join(', ')}`);
  for (const p of cur.posts.slice(0, 3)) {
    lines.push(`• ${p.title || '(без назви)'} — ` + Object.entries(p.metrics).map(([k, v]) => `${label(k)} ${num(v)}`).join(', ') + (p.url ? `\n  ${p.url}` : ''));
  }
  return lines.join('\n');
}
