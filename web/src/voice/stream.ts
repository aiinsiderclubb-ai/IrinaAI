import type { Proposal } from '../types';

const RATE = 24_000;

/**
 * Plays the assistant's voice as it arrives: PCM 24 kHz chunks (or whole mp3 pieces) are scheduled
 * back to back on one AudioContext, so speech starts with the first ~100 ms instead of the whole answer.
 */
export class StreamPlayer {
  readonly ctx = new AudioContext({ sampleRate: RATE });
  private analyser = this.ctx.createAnalyser();
  private out = this.ctx.createGain();
  private sources = new Set<AudioBufferSourceNode>();
  private at = 0;
  private buf = new Uint8Array(512);
  private chain: Promise<void> = Promise.resolve();
  onStart?: () => void;
  onIdle?: () => void;

  constructor() {
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** must be called from a user gesture once (browser autoplay rules) */
  unlock(): void {
    void this.ctx.resume();
  }

  pushPcm(b64: string): void {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const n = bytes.length >> 1;
    const buffer = this.ctx.createBuffer(1, n, RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    this.schedule(buffer);
  }

  pushMp3(b64: string): void {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // decoding is async: keep the order of pieces
    this.chain = this.chain.then(() =>
      this.ctx
        .decodeAudioData(bytes.buffer)
        .then((b) => this.schedule(b))
        .catch(() => {}),
    );
  }

  private schedule(buffer: AudioBuffer): void {
    void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    // jitter buffer: start a fresh stream ~0.25 s ahead; after an underrun, rebuffer a little instead of stuttering
    const now = this.ctx.currentTime;
    const startAt = this.at > now ? this.at : now + (this.sources.size ? 0.15 : 0.25);
    src.start(startAt);
    this.at = startAt + buffer.duration;
    if (!this.sources.size) this.onStart?.();
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.onIdle?.();
    };
  }

  /** barge-in / stop: cut everything already scheduled */
  stop(): void {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started yet */
      }
    }
    this.sources.clear();
    this.at = 0;
    this.chain = Promise.resolve();
  }

  level(): number {
    if (!this.sources.size) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 3.2);
  }

  close(): void {
    this.stop();
    void this.ctx.close().catch(() => {});
  }
}

export interface TurnHandlers {
  onTranscript?(text: string): void;
  onSkipped?(): void;
  onText?(delta: string): void;
  onProposals?(items: Proposal[]): void;
  onDone?(text: string): void;
}

/** One streamed turn against /api/voice/stream. Audio events go straight into the player. */
export async function streamTurn(opts: {
  body: Blob | Record<string, unknown>;
  query?: string;
  player?: StreamPlayer;
  handlers: TurnHandlers;
  signal?: AbortSignal;
}): Promise<void> {
  const isAudio = opts.body instanceof Blob;
  const res = await fetch(`/api/voice/stream${opts.query ? `?${opts.query}` : ''}`, {
    method: 'POST',
    credentials: 'same-origin',
    signal: opts.signal,
    headers: { 'x-requested-with': 'aia', 'content-type': isAudio ? (opts.body as Blob).type || 'audio/webm' : 'application/json' },
    body: isAudio ? (opts.body as Blob) : JSON.stringify(opts.body),
  });
  if (res.status === 401) window.dispatchEvent(new Event('aia:unauthorized'));
  if (!res.ok || !res.body) throw new Error(`Помилка ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      switch (ev.type) {
        case 'transcript':
          opts.handlers.onTranscript?.(ev.text);
          break;
        case 'skipped':
          opts.handlers.onSkipped?.();
          break;
        case 'text':
          opts.handlers.onText?.(ev.delta);
          break;
        case 'audio':
          if (ev.format === 'pcm24') opts.player?.pushPcm(ev.data);
          else opts.player?.pushMp3(ev.data);
          break;
        case 'proposals':
          opts.handlers.onProposals?.(ev.items);
          break;
        case 'done':
          opts.handlers.onDone?.(ev.text);
          break;
        case 'error':
          throw new Error(ev.message);
      }
    }
  }
}
