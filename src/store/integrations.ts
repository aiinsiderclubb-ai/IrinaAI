import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { kvGet, kvSet } from './kv.js';

export interface WebhookParam {
  name: string;
  description: string;
  required: boolean;
}

/** An action the owner wires in Make / Zapier / n8n: the assistant fills the parameters, the owner confirms, we POST JSON. */
export interface WebhookIntegration {
  id: string;
  type: 'webhook';
  name: string;
  description: string;
  url: string;
  /** sent as `X-Assistant-Secret` so the receiving scenario can verify the call */
  secret?: string;
  params: WebhookParam[];
  enabled: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  /** true = the call is shown as a card and runs only after «Підтвердити» */
  confirm: boolean;
}

/** A remote MCP server (Streamable HTTP). Its tools become the assistant's tools, the owner picks which ones. */
export interface McpIntegration {
  id: string;
  type: 'mcp';
  name: string;
  url: string;
  /** e.g. `Bearer …` */
  authorization?: string;
  tools: McpTool[];
  enabled: boolean;
}

export type CustomIntegration = WebhookIntegration | McpIntegration;
/** distributive: id optional for each variant (new items get one) */
export type CustomDraft = CustomIntegration extends infer T ? (T extends CustomIntegration ? Omit<T, 'id'> & { id?: string } : never) : never;

/** Everything that can be configured from the cabinet. Secrets are encrypted at rest (AES-256-GCM). */
export interface IntegrationConfig {
  notion?: { token?: string; tasksDb?: string; contextPages?: string[]; readOnly?: boolean };
  google?: {
    clientId?: string;
    clientSecret?: string;
    /** calendar per account; a calendar shared with the connected Google account works too (default `primary`) */
    calendars?: { work?: string; personal?: string };
    /** calendar writes (events, day plan, work↔personal mirror) are off unless explicitly false */
    readOnly?: boolean;
  };
  meta?: { appId?: string; appSecret?: string };
  elevenlabs?: { apiKey?: string };
  openai?: { apiKey?: string };
  custom?: CustomIntegration[];
}

/** Field paths holding secrets: stored encrypted, shown masked. */
const SECRET_FIELDS: Array<[keyof IntegrationConfig, string]> = [
  ['notion', 'token'],
  ['google', 'clientSecret'],
  ['meta', 'appSecret'],
  ['elevenlabs', 'apiKey'],
  ['openai', 'apiKey'],
];

export const mask = (v?: string) => (v ? `•••• ${v.slice(-4)}` : undefined);

const KEY = 'integrations';

export class IntegrationStore {
  private cache?: IntegrationConfig;
  constructor(
    private db: Db,
    private encKey: string,
  ) {}

  async get(): Promise<IntegrationConfig> {
    if (this.cache) return this.cache;
    const raw = (await kvGet<IntegrationConfig>(this.db, KEY)) ?? {};
    const cfg: IntegrationConfig = structuredClone(raw);
    for (const [section, field] of SECRET_FIELDS) {
      const sec = cfg[section] as Record<string, unknown> | undefined;
      if (sec && typeof sec[field] === 'string') sec[field] = decrypt(sec[field] as string, this.encKey);
    }
    for (const c of cfg.custom ?? []) {
      if (c.type === 'webhook' && c.secret) c.secret = decrypt(c.secret, this.encKey);
      if (c.type === 'mcp' && c.authorization) c.authorization = decrypt(c.authorization, this.encKey);
    }
    this.cache = cfg;
    return cfg;
  }

  async save(next: IntegrationConfig): Promise<IntegrationConfig> {
    const stored: IntegrationConfig = structuredClone(next);
    for (const [section, field] of SECRET_FIELDS) {
      const sec = stored[section] as Record<string, unknown> | undefined;
      if (sec && typeof sec[field] === 'string' && sec[field]) sec[field] = encrypt(sec[field] as string, this.encKey);
      else if (sec) delete sec[field];
    }
    for (const c of stored.custom ?? []) {
      if (c.type === 'webhook' && c.secret) c.secret = encrypt(c.secret, this.encKey);
      if (c.type === 'mcp' && c.authorization) c.authorization = encrypt(c.authorization, this.encKey);
    }
    await kvSet(this.db, KEY, stored);
    this.cache = structuredClone(next);
    return this.cache;
  }

  /** Merge a section; empty-string secrets mean "keep the current value" (the form only shows them masked). */
  async patch<K extends Exclude<keyof IntegrationConfig, 'custom'>>(section: K, values: NonNullable<IntegrationConfig[K]>): Promise<IntegrationConfig> {
    const cur = await this.get();
    const merged = { ...(cur[section] as object), ...(values as object) } as Record<string, unknown>;
    for (const [sec, field] of SECRET_FIELDS) if (sec === section && merged[field] === '') merged[field] = (cur[section] as Record<string, unknown> | undefined)?.[field];
    return this.save({ ...cur, [section]: merged });
  }

  async clear(section: Exclude<keyof IntegrationConfig, 'custom'>): Promise<IntegrationConfig> {
    const cur = await this.get();
    const { [section]: _drop, ...rest } = cur;
    return this.save(rest);
  }

  async upsertCustom(item: CustomDraft): Promise<CustomIntegration> {
    const cur = await this.get();
    const list = cur.custom ?? [];
    const prev = item.id ? list.find((c) => c.id === item.id) : undefined;
    const next = { ...prev, ...item, id: item.id ?? randomUUID() } as CustomIntegration;
    // keep an existing secret when the form sends an empty one
    if (next.type === 'webhook' && !next.secret && prev?.type === 'webhook') next.secret = prev.secret;
    if (next.type === 'mcp' && !next.authorization && prev?.type === 'mcp') next.authorization = prev.authorization;
    await this.save({ ...cur, custom: [...list.filter((c) => c.id !== next.id), next] });
    return next;
  }

  async removeCustom(id: string): Promise<void> {
    const cur = await this.get();
    await this.save({ ...cur, custom: (cur.custom ?? []).filter((c) => c.id !== id) });
  }
}
