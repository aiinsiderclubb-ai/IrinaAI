/** Normalised snapshot of one social account (Instagram or YouTube), stored daily to build "dynamics". */
export interface SocialPost {
  title: string;
  url?: string;
  publishedAt?: string;
  metrics: Record<string, number>;
}

export interface SocialData {
  platform: 'instagram' | 'youtube';
  account: string;
  takenAt: string;
  /** lifetime counters: followers, posts, total views ... */
  totals: Record<string, number>;
  /** metrics over `periodDays`: reach, views, engagement ... (only those the official API returned) */
  period: Record<string, number>;
  periodDays: number;
  posts: SocialPost[];
  /** metrics the API refused for this account type; shown honestly instead of invented */
  unavailable: string[];
}
