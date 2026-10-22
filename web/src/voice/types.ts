import type { Proposal } from '../types';

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

export interface VoiceHandlers {
  onStatus(s: VoiceStatus): void;
  onLine(role: 'user' | 'assistant' | 'system', text: string): void;
  onProposals(p: Proposal[]): void;
  onError(msg: string): void;
}

export interface VoiceEngine {
  readonly kind: 'realtime' | 'standard';
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  /** proactive message from the server: say it out loud */
  announce(text: string): void;
  level(): number;
  readonly active: boolean;
}

export class RealtimeUnavailable extends Error {}
