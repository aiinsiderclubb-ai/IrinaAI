import { HttpError, httpJson } from '../lib/http.js';
import type { Clock } from '../lib/time.js';
import type { TokenStore } from '../store/tokens.js';
import type { SocialData, SocialPost } from './social-types.js';

const GRAPH = 'https://graph.instagram.com/v23.0';
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
const LONG_LIVED_DAYS = 60;

export class InstagramNotConnected extends Error {
  constructor(msg = 'Instagram не підключено') {
    super(msg);
  }
}

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export class InstagramClient {
  constructor(
    private cfg: InstagramConfig,
    private tokens: TokenStore,
    private clock: Clock = () => new Date(),
  ) {}

  authUrl(state: string): string {
    const u = new URL('https://www.instagram.com/oauth/authorize');
    u.search = new URLSearchParams({
      client_id: this.cfg.appId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
    }).toString();
    return u.toString();
  }

  async exchangeCode(code: string): Promise<void> {
    const short = await httpJson<{ access_token: string; user_id?: number | string }>('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      form: {
        client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: this.cfg.redirectUri,
        code,
      },
      retries: 0,
    });
    const long = await httpJson<{ access_token: string; expires_in: number }>('https://graph.instagram.com/access_token', {
      query: { grant_type: 'ig_exchange_token', client_secret: this.cfg.appSecret, access_token: short.access_token },
    });
    const me = await httpJson<{ user_id?: string; id?: string; username?: string }>(`${GRAPH}/me`, {
      query: { fields: 'user_id,username', access_token: long.access_token },
    });
    await this.tokens.save('instagram', {
      accessToken: long.access_token,
      expiresAt: new Date(this.clock().getTime() + long.expires_in * 1000),
      meta: { userId: me.user_id ?? me.id ?? String(short.user_id ?? ''), username: me.username ?? '', broken: false },
    });
  }

  private async token(): Promise<{ token: string; userId: string }> {
    const t = await this.tokens.get('instagram');
    if (!t?.accessToken) throw new InstagramNotConnected();
    return { token: t.accessToken, userId: String(t.meta.userId ?? 'me') };
  }

  /** Long-lived tokens live 60 days: refresh once they are > 1 day old. Returns the new expiry. */
  async refreshToken(force = false): Promise<Date | undefined> {
    const t = await this.tokens.get('instagram');
    if (!t?.accessToken) return undefined;
    const ageMs = this.clock().getTime() - t.updatedAt.getTime();
    if (!force && ageMs < 24 * 3600_000 && t.expiresAt) return t.expiresAt;
    try {
      const res = await httpJson<{ access_token: string; expires_in: number }>('https://graph.instagram.com/refresh_access_token', {
        query: { grant_type: 'ig_refresh_token', access_token: t.accessToken },
        retries: 1,
      });
      const expiresAt = new Date(this.clock().getTime() + (res.expires_in || LONG_LIVED_DAYS * 86400) * 1000);
      await this.tokens.save('instagram', { accessToken: res.access_token, expiresAt, meta: { broken: false } });
      return expiresAt;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 401)) await this.tokens.save('instagram', { meta: { broken: true } });
      throw e;
    }
  }

  private async tryMetric(userId: string, token: string, metric: string, sinceSec: number, untilSec: number): Promise<number | undefined> {
    try {
      const res = await httpJson<any>(`${GRAPH}/${userId}/insights`, {
        query: { metric, period: 'day', metric_type: 'total_value', since: sinceSec, until: untilSec, access_token: token },
        retries: 0,
      });
      const v = res.data?.[0]?.total_value?.value;
      return typeof v === 'number' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async snapshot(periodDays = 7): Promise<SocialData> {
    const { token, userId } = await this.token();
    const nowSec = Math.floor(this.clock().getTime() / 1000);
    const sinceSec = nowSec - periodDays * 86400;
    const profile = await httpJson<any>(`${GRAPH}/me`, {
      query: { fields: 'username,followers_count,follows_count,media_count', access_token: token },
    });

    const unavailable: string[] = [];
    const period: Record<string, number> = {};
    for (const metric of ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_views']) {
      const v = await this.tryMetric(userId, token, metric, sinceSec, nowSec);
      if (v === undefined) unavailable.push(metric);
      else period[metric] = v;
    }

    const media = await httpJson<{ data?: any[] }>(`${GRAPH}/me/media`, {
      query: { fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: 8, access_token: token },
    });
    const posts: SocialPost[] = [];
    for (const m of media.data ?? []) {
      const metrics: Record<string, number> = { likes: m.like_count ?? 0, comments: m.comments_count ?? 0 };
      try {
        const ins = await httpJson<any>(`${GRAPH}/${m.id}/insights`, {
          query: { metric: 'reach,saved,shares,views', access_token: token },
          retries: 0,
        });
        for (const d of ins.data ?? []) if (typeof d.values?.[0]?.value === 'number') metrics[d.name] = d.values[0].value;
      } catch {
        /* per-media insights are not available for every media type */
      }
      posts.push({ title: String(m.caption ?? m.media_type ?? '').split('\n')[0]!.slice(0, 80), url: m.permalink, publishedAt: m.timestamp, metrics });
    }

    return {
      platform: 'instagram',
      account: profile.username ?? '',
      takenAt: this.clock().toISOString(),
      totals: { followers: profile.followers_count ?? 0, following: profile.follows_count ?? 0, posts: profile.media_count ?? 0 },
      period,
      periodDays,
      posts,
      unavailable,
    };
  }
}
