import { HttpError, httpJson } from '../lib/http.js';
import type { Clock } from '../lib/time.js';
import type { Slot, TokenStore } from '../store/tokens.js';

export const SCOPES: Record<Exclude<Slot, 'instagram'>, string[]> = {
  'google:work': ['https://www.googleapis.com/auth/calendar'],
  'google:personal': ['https://www.googleapis.com/auth/calendar'],
  // read-only (contract §7.7)
  'google:youtube': ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
};

export class GoogleAuthError extends Error {
  constructor(
    readonly slot: Slot,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export class GoogleAuth {
  constructor(
    private cfg: GoogleOAuthConfig,
    private tokens: TokenStore,
    private clock: Clock = () => new Date(),
  ) {}

  authUrl(slot: Exclude<Slot, 'instagram'>, state: string): string {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES[slot].join(' '),
      access_type: 'offline',
      prompt: 'consent', // always return a refresh_token
      state,
    }).toString();
    return u.toString();
  }

  async exchangeCode(slot: Slot, code: string): Promise<void> {
    const res = await httpJson<TokenResponse>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        code,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: this.cfg.redirectUri,
        grant_type: 'authorization_code',
      },
      retries: 0,
    });
    await this.tokens.save(slot, {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: new Date(this.clock().getTime() + res.expires_in * 1000),
      scope: res.scope,
      meta: { broken: false },
    });
  }

  async accessToken(slot: Slot): Promise<string> {
    const t = await this.tokens.get(slot);
    if (!t?.refreshToken) throw new GoogleAuthError(slot, `Google (${slot}) не підключено`);
    if (t.accessToken && t.expiresAt && t.expiresAt.getTime() - this.clock().getTime() > 60_000) return t.accessToken;
    try {
      const res = await httpJson<TokenResponse>('https://oauth2.googleapis.com/token', {
        method: 'POST',
        form: {
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          refresh_token: t.refreshToken,
          grant_type: 'refresh_token',
        },
        retries: 1,
      });
      await this.tokens.save(slot, {
        accessToken: res.access_token,
        expiresAt: new Date(this.clock().getTime() + res.expires_in * 1000),
        meta: { broken: false },
      });
      return res.access_token;
    } catch (e) {
      if (e instanceof HttpError && e.status === 400 && /invalid_grant/.test(e.body)) {
        await this.tokens.save(slot, { meta: { broken: true } });
        throw new GoogleAuthError(slot, `Доступ Google (${slot}) втрачено, потрібно підключити знову`);
      }
      throw e;
    }
  }

  async authedJson<T>(slot: Slot, url: string, opts: Parameters<typeof httpJson>[1] = {}): Promise<T> {
    const token = await this.accessToken(slot);
    return httpJson<T>(url, { ...opts, headers: { ...opts.headers, authorization: `Bearer ${token}` } });
  }
}
