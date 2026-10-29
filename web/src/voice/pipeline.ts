import { api, ApiError } from '../api';
import { LevelMeter } from './level';
import { StreamPlayer, streamTurn } from './stream';
import type { VoiceEngine, VoiceHandlers } from './types';

const FOLLOW_UP_MS = 9000;
const IDLE_STOP_MS = { handsFree: 20 * 60_000, normal: 5 * 60_000 };
const FRAME_MS = 30;
const START_FRAMES = 3; // ~90 ms above threshold = speech
const END_SILENCE_MS = 900;
const MIN_UTTERANCE_MS = 450;
const MAX_UTTERANCE_MS = 30_000;

/**
 * Hands-free conversation without the Realtime API: own voice-activity detection in the browser,
 * each phrase -> /api/voice (transcribe, agent, speech) -> played back. The owner can interrupt by speaking.
 */
export class StandardVoice implements VoiceEngine {
  readonly kind = 'standard' as const;
  private mic?: MediaStream;
  private meter?: LevelMeter;
  private player?: StreamPlayer;
  private turn?: AbortController;
  private streaming = false;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private timer?: number;
  private aboveFrames = 0;
  private silenceSince = 0;
  private speechStart = 0;
  private noiseFloor = 0.01;
  private calibrateUntil = 0;
  private busy = false;
  private muted = false;
  private followUntil = 0;
  private lastActivity = Date.now();
  private running = false;
  /** ignore the mic until then: the tail of the assistant's voice still rings in the room */
  private quietUntil = 0;
  private bargeIn = localStorage.getItem('aia.bargeIn') === '1';

  constructor(
    private h: VoiceHandlers,
    private handsFree: boolean,
  ) {}

  private makePlayer(): StreamPlayer {
    const p = new StreamPlayer();
    p.onStart = () => this.running && this.h.onStatus('speaking');
    p.onIdle = () => {
      this.quietUntil = Date.now() + 700;
      this.followUntil = Date.now() + FOLLOW_UP_MS;
      // more audio may still be on its way while the stream is open
      if (this.running && !this.streaming) this.h.onStatus('listening');
    };
    return p;
  }

  get active(): boolean {
    return this.running;
  }

  level(): number {
    return Math.max(this.meter?.level() ?? 0, this.player?.level() ?? 0);
  }

  async start(): Promise<void> {
    this.h.onStatus('connecting');
    const info = await api.post<{ greet: boolean; tts: boolean }>('/api/voice/start');
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.meter = new LevelMeter();
    this.meter.addStream(this.mic); // analyser 0 = mic
    this.player = this.makePlayer();
    this.player.unlock();
    this.running = true;
    this.calibrateUntil = Date.now() + 600;
    this.timer = window.setInterval(() => this.frame(), FRAME_MS);
    this.h.onStatus('listening');
    if (info.greet) void this.run({ ask: 'Привітайся коротко і дай брифінг дня у 2–3 реченнях СТРОГО за блоком «СЬОГОДНІ» і «ДЖЕРЕЛА ДАНИХ». Чого там немає — не згадуй; якщо джерела не підключені, так і скажи одним реченням.' });
  }

  stop(): void {
    this.running = false;
    window.clearInterval(this.timer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.turn?.abort();
    this.player?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.meter?.close();
    this.h.onStatus('idle');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  announce(text: string): void {
    if (!this.running) return;
    void this.run({ say: text });
  }

  interrupt(): void {
    this.turn?.abort();
    this.player?.stop();
    this.quietUntil = Date.now() + 300;
    if (this.running) this.h.onStatus('listening');
  }

  /** One streamed turn: text and voice arrive sentence by sentence. */
  private async run(body: Blob | Record<string, unknown>, query?: string): Promise<void> {
    this.busy = true;
    this.streaming = true;
    this.h.onStatus('thinking');
    this.turn = new AbortController();
    let text = '';
    let skipped = false;
    try {
      await streamTurn({
        body,
        query,
        player: this.player,
        signal: this.turn.signal,
        handlers: {
          onTranscript: (t) => t && this.h.onLine('user', t),
          onSkipped: () => (skipped = true),
          onText: (d) => (text += d),
          onProposals: (items) => this.h.onProposals(items),
          onDone: (t) => {
            if (t || text) this.h.onLine('assistant', t || text);
          },
        },
      });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) this.h.onError(e instanceof ApiError ? e.message : String(e));
    } finally {
      this.busy = false;
      this.streaming = false;
      if (this.running && (skipped || !this.player?.playing)) this.h.onStatus('listening');
    }
  }

  private frame(): void {
    if (!this.meter || this.muted) return;
    const now = Date.now();
    const rms = this.meter.rms(0);
    if (now < this.calibrateUntil) {
      this.noiseFloor = Math.max(this.noiseFloor * 0.8 + rms * 0.2, 0.004);
      return;
    }
    const speaking = Boolean(this.player?.playing) || now < this.quietUntil;
    // Half-duplex: while the assistant talks (and a moment after) the mic hears mostly the speakers, so we do not
    // start recording at all. Tap on the core interrupts. With headphones, «перебивати голосом» re-enables barge-in.
    if (speaking && !this.bargeIn) {
      this.aboveFrames = 0;
      return;
    }
    const threshold = Math.max(0.018, this.noiseFloor * 3) * (speaking ? 2.5 : 1);
    const recording = this.recorder?.state === 'recording';

    if (rms > threshold) {
      this.aboveFrames++;
      this.silenceSince = 0;
      if (!recording && !this.busy && this.aboveFrames >= START_FRAMES) {
        if (speaking) this.player?.stop(); // barge-in
        this.beginUtterance();
      }
    } else {
      this.aboveFrames = 0;
      if (!recording) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
      if (recording) {
        if (!this.silenceSince) this.silenceSince = now;
        if (now - this.silenceSince > END_SILENCE_MS) this.endUtterance();
      }
    }
    if (recording && now - this.speechStart > MAX_UTTERANCE_MS) this.endUtterance();

    const idleLimit = this.handsFree ? IDLE_STOP_MS.handsFree : IDLE_STOP_MS.normal;
    if (now - this.lastActivity > idleLimit) {
      this.h.onLine('system', 'Сесію завершено через тишу.');
      this.stop();
    }
  }

  private beginUtterance(): void {
    if (!this.mic) return;
    const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.chunks = [];
    this.recorder = new MediaRecorder(this.mic, type ? { mimeType: type } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => void this.send();
    this.speechStart = Date.now();
    this.lastActivity = Date.now();
    this.recorder.start();
    this.h.onStatus('hearing');
  }

  private endUtterance(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  private async send(): Promise<void> {
    const duration = Date.now() - this.speechStart - END_SILENCE_MS;
    const blob = new Blob(this.chunks, { type: (this.recorder?.mimeType || 'audio/webm').split(';')[0] });
    if (duration < MIN_UTTERANCE_MS || blob.size < 2000 || !this.running) {
      this.h.onStatus('listening');
      return;
    }
    const follow = Date.now() < this.followUntil ? '1' : '0';
    await this.run(blob, `handsFree=${this.handsFree ? 1 : 0}&follow=${follow}`);
  }
}
