import type { Clock } from '../lib/time.js';
import type { GoogleAuth } from './google-auth.js';
import type { SocialData, SocialPost } from './social-types.js';

const SLOT = 'google:youtube' as const;
const DATA = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export class YouTubeClient {
  constructor(
    private auth: GoogleAuth,
    private clock: Clock = () => new Date(),
  ) {}

  async snapshot(periodDays = 7): Promise<SocialData> {
    const channels = await this.auth.authedJson<any>(SLOT, `${DATA}/channels`, {
      query: { part: 'snippet,statistics,contentDetails', mine: 'true' },
    });
    const ch = channels.items?.[0];
    if (!ch) throw new Error('YouTube: канал не знайдено для цього акаунта');

    const end = this.clock();
    const start = new Date(end.getTime() - periodDays * 86400_000);
    const unavailable: string[] = [];
    const period: Record<string, number> = {};
    try {
      const metrics = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments'];
      const rep = await this.auth.authedJson<any>(SLOT, ANALYTICS, {
        query: { ids: 'channel==MINE', startDate: iso(start), endDate: iso(end), metrics: metrics.join(',') },
        retries: 0,
      });
      const row: number[] = rep.rows?.[0] ?? [];
      (rep.columnHeaders ?? []).forEach((h: any, i: number) => {
        if (typeof row[i] === 'number') period[h.name] = row[i]!;
      });
    } catch {
      unavailable.push('analytics');
    }

    const posts: SocialPost[] = [];
    const uploads: string | undefined = ch.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      const items = await this.auth.authedJson<any>(SLOT, `${DATA}/playlistItems`, {
        query: { part: 'contentDetails', playlistId: uploads, maxResults: 8 },
      });
      const ids = (items.items ?? []).map((i: any) => i.contentDetails.videoId).join(',');
      if (ids) {
        const vids = await this.auth.authedJson<any>(SLOT, `${DATA}/videos`, { query: { part: 'snippet,statistics', id: ids } });
        for (const v of vids.items ?? []) {
          posts.push({
            title: v.snippet.title,
            url: `https://youtu.be/${v.id}`,
            publishedAt: v.snippet.publishedAt,
            metrics: {
              views: Number(v.statistics.viewCount ?? 0),
              likes: Number(v.statistics.likeCount ?? 0),
              comments: Number(v.statistics.commentCount ?? 0),
            },
          });
        }
      }
    }

    return {
      platform: 'youtube',
      account: ch.snippet.title,
      takenAt: end.toISOString(),
      totals: {
        subscribers: Number(ch.statistics.subscriberCount ?? 0),
        views: Number(ch.statistics.viewCount ?? 0),
        videos: Number(ch.statistics.videoCount ?? 0),
      },
      period,
      periodDays,
      posts,
      unavailable,
    };
  }
}
