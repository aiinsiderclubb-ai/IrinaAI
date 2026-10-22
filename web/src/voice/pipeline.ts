import { api, ApiError } from '../api';
import type { Proposal } from '../types';
import { LevelMeter } from './level';
import type { VoiceEngine, VoiceHandlers } from './types';

interface Reply {
  transcript?: string;
  text: string;
  proposals: Proposal[];
  audio?: string;
  skipped?: boolean;
}

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
  private player = new Audio();
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

  constructor(
    private h: VoiceHandlers,
    private handsFree: boolean,
  ) {
    this.player.onplay = () => this.h.onStatus('speaking');
    this.player.onended = () => {
      this.followUntil = Date.now() + FOLLOW_UP_MS;
      if (this.running) this.h.onStatus('listening');
    };
  }

  get active(): boolean {
    return this.running;
  }

  level(): number {
    return this.meter?.level() ?? 0;
  }

  async start(): Promise<void> {
    this.h.onStatus('connecting');
    const info = await api.post<{ greet: boolean; tts: boolean }>('/api/voice/start');
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.meter = new LevelMeter();
    this.meter.addStream(this.mic); // analyser 0 = mic
    this.meter.addElement(this.player); // analyser 1 = assistant voice
    this.running = true;
    this.calibrateUntil = Date.now() + 600;
    this.timer = window.setInterval(() => this.frame(), FRAME_MS);
    this.h.onStatus('listening');
    if (info.greet) void this.say({ text: 'Привітайся коротко і дай брифінг дня: подивись календар і задачі на сьогодні та скажи головне у 2–3 реченнях.', ask: true });
  }

  stop(): void {
    this.running = false;
    window.clearInterval(this.timer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.player.pause();
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
    void this.say({ text });
  }

  private async say(body: { text: string; ask?: boolean }): Promise<void> {
    this.busy = true;
    this.h.onStatus('thinking');
    try {
      this.handle(await api.post<Reply>('/api/voice/speak', body), false);
    } catch (e) {
      this.h.onError(e instanceof ApiError ? e.message : String(e));
      this.h.onStatus('listening');
    } finally {
      this.busy = false;
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
    const speaking = !this.player.paused;
    // while the assistant talks, demand a louder voice so its own sound leaking into the mic is not "speech"
    const threshold = Math.max(0.018, this.noiseFloor * 3) * (speaking ? 2.5 : 1);
    const recording = this.recorder?.state === 'recording';

    if (rms > threshold) {
      this.aboveFrames++;
      this.silenceSince = 0;
      if (!recording && !this.busy && this.aboveFrames >= START_FRAMES) {
        if (speaking) this.player.pause(); // barge-in
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
    this.busy = true;
    this.h.onStatus('thinking');
    const follow = Date.now() < this.followUntil ? '1' : '0';
    try {
      const r = await api.upload<Reply>(`/api/voice?conversation=1&handsFree=${this.handsFree ? 1 : 0}&follow=${follow}`, blob);
      this.handle(r, true);
    } catch (e) {
      this.h.onError(e instanceof ApiError ? e.message : String(e));
      this.h.onStatus('listening');
    } finally {
      this.busy = false;
    }
  }

  private handle(r: Reply, fromUser: boolean): void {
    if (fromUser && r.transcript) this.h.onLine('user', r.transcript);
    if (r.skipped) {
      this.h.onStatus('listening');
      return;
    }
    if (r.text) this.h.onLine('assistant', r.text);
    if (r.proposals.length) this.h.onProposals(r.proposals);
    if (r.audio && this.running) {
      this.player.src = `data:audio/mpeg;base64,${r.audio}`;
      void this.player.play().catch(() => this.h.onStatus('listening'));
    } else this.h.onStatus('listening');
  }
}
