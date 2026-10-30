import { HttpError, httpJson } from '../lib/http.js';
import type { Clock } from '../lib/time.js';
import type { TokenStore } from '../store/tokens.js';
import type { SocialData, SocialPost } from './social-types.js';

const GRAPH = 'https://graph.instagram.com/v23.0';
const FB_GRAPH = 'https://graph.facebook.com/v23.0';
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
/** Facebook Login: the account is reached through a Page or a business portfolio the logged-in person has access to */
const FB_SCOPES = ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'];
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
  /**
   * `facebook` (default): log in with a Facebook account that was given access to the Instagram account
   * (Page or business portfolio). `instagram`: log in as the Instagram account itself.
   */
  login?: 'facebook' | 'instagram';
  /** Facebook Login for Business configuration; when set it replaces the scope list */
  configId?: string;
}

interface IgAccount {
  id: string;
  username: string;
  pageToken?: string;
}

export class InstagramClient {
  constructor(
    private cfg: InstagramConfig,
    private tokens: TokenStore,
    private clock: Clock = () => new Date(),
  ) {}

  private get viaFacebook(): boolean {
    return this.cfg.login !== 'instagram';
  }

  authUrl(state: string): string {
    if (this.viaFacebook) {
      const u = new URL('https://www.facebook.com/v23.0/dialog/oauth');
      const q: Record<string, string> = { client_id: this.cfg.appId, redirect_uri: this.cfg.redirectUri, response_type: 'code', state };
      if (this.cfg.configId) q.config_id = this.cfg.configId;
      else q.scope = FB_SCOPES.join(',');
      u.search = new URLSearchParams(q).toString();
      return u.toString();
    }
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
    if (this.viaFacebook) return this.exchangeFacebookCode(code);
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
      meta: { login: 'instagram', userId: me.user_id ?? me.id ?? String(short.user_id ?? ''), username: me.username ?? '', broken: false },
    });
  }

  private async exchangeFacebookCode(code: string): Promise<void> {
    const short = await httpJson<{ access_token: string }>(`${FB_GRAPH}/oauth/access_token`, {
      query: { client_id: this.cfg.appId, client_secret: this.cfg.appSecret, redirect_uri: this.cfg.redirectUri, code },
      retries: 0,
    });
    const long = await httpJson<{ access_token: string; expires_in?: number }>(`${FB_GRAPH}/oauth/access_token`, {
      query: { grant_type: 'fb_exchange_token', client_id: this.cfg.appId, client_secret: this.cfg.appSecret, fb_exchange_token: short.access_token },
    });
    const accounts = await this.findAccounts(long.access_token);
    const ig = accounts[0];
    if (!ig) throw new InstagramNotConnected('Цей акаунт Facebook не бачить жодного Instagram Business / Creator. Перевірте доступ у бізнес-портфоліо.');
    // a Page token made from a long-lived user token does not expire; without a Page the user token lives 60 days
    await this.tokens.save('instagram', {
      accessToken: ig.pageToken ?? long.access_token,
      expiresAt: ig.pageToken ? null : new Date(this.clock().getTime() + (long.expires_in || LONG_LIVED_DAYS * 86400) * 1000),
      meta: { login: 'facebook', userId: ig.id, username: ig.username, accounts: accounts.map((a) => a.username), broken: false },
    });
  }

  /** Instagram accounts reachable with a Facebook user token: through Pages first, then business portfolios. */
  private async findAccounts(userToken: string): Promise<IgAccount[]> {
    const out: IgAccount[] = [];
    const seen = new Set<string>();
    const add = (a: IgAccount) => {
      if (seen.has(a.id)) return;
      seen.add(a.id);
      out.push(a);
    };
    const pages = await httpJson<{ data?: any[] }>(`${FB_GRAPH}/me/accounts`, {
      query: { fields: 'name,access_token,instagram_business_account{id,username}', limit: 100, access_token: userToken },
    });
    for (const p of pages.data ?? []) {
      const ig = p.instagram_business_account;
      if (ig?.id) add({ id: ig.id, username: ig.username ?? '', pageToken: p.access_token });
    }
    try {
      const biz = await httpJson<{ data?: any[] }>(`${FB_GRAPH}/me/businesses`, { query: { fields: 'id,name', limit: 50, access_token: userToken }, retries: 0 });
      for (const b of biz.data ?? []) {
        for (const edge of ['instagram_business_accounts', 'owned_instagram_accounts', 'client_instagram_accounts']) {
          try {
            const res = await httpJson<{ data?: any[] }>(`${FB_GRAPH}/${b.id}/${edge}`, { query: { fields: 'id,username', limit: 50, access_token: userToken }, retries: 0 });
            for (const ig of res.data ?? []) if (ig?.id) add({ id: ig.id, username: ig.username ?? '' });
          } catch {
            /* the edge needs a role this person may not have in the portfolio */
          }
        }
      }
    } catch {
      /* business_management not granted: Pages are enough */
    }
    return out;
  }

  private async token(): Promise<{ token: string; userId: string; graph: string }> {
    const t = await this.tokens.get('instagram');
    if (!t?.accessToken) throw new InstagramNotConnected();
    const fb = t.meta.login === 'facebook';
    return { token: t.accessToken, userId: String(t.meta.userId ?? 'me'), graph: fb ? FB_GRAPH : GRAPH };
  }

  /** Long-lived tokens live 60 days: refresh once they are > 1 day old. Returns the new expiry. */
  async refreshToken(force = false): Promise<Date | undefined> {
    const t = await this.tokens.get('instagram');
    if (!t?.accessToken) return undefined;
    // Facebook Login: Page tokens do not expire, a user token can only be renewed by logging in again
    if (t.meta.login === 'facebook') return t.expiresAt;
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

  private async tryMetric(graph: string, userId: string, token: string, metric: string, sinceSec: number, untilSec: number): Promise<number | undefined> {
    try {
      const res = await httpJson<any>(`${graph}/${userId}/insights`, {
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
    const { token, userId, graph } = await this.token();
    const self = graph === FB_GRAPH ? userId : 'me';
    const nowSec = Math.floor(this.clock().getTime() / 1000);
    const sinceSec = nowSec - periodDays * 86400;
    const profile = await httpJson<any>(`${graph}/${self}`, {
      query: { fields: 'username,followers_count,follows_count,media_count', access_token: token },
    });

    const unavailable: string[] = [];
    const period: Record<string, number> = {};
    for (const metric of ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_views']) {
      const v = await this.tryMetric(graph, userId, token, metric, sinceSec, nowSec);
      if (v === undefined) unavailable.push(metric);
      else period[metric] = v;
    }

    const media = await httpJson<{ data?: any[] }>(`${graph}/${self}/media`, {
      query: { fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: 8, access_token: token },
    });
    const posts: SocialPost[] = [];
    for (const m of media.data ?? []) {
      const metrics: Record<string, number> = { likes: m.like_count ?? 0, comments: m.comments_count ?? 0 };
      try {
        const ins = await httpJson<any>(`${graph}/${m.id}/insights`, {
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
