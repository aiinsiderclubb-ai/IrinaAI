import { api } from '../api';
import type { Proposal } from '../types';
import { isAddressed } from '../../../src/lib/wake';
import { LevelMeter } from './level';
import { RealtimeUnavailable, type VoiceEngine, type VoiceHandlers } from './types';

interface SessionInfo {
  value: string;
  model: string;
  assistantName: string;
  greet: boolean;
}

/** After the assistant spoke, the owner can answer without saying the name again. */
const FOLLOW_UP_MS = 9000;
const IDLE_STOP_MS = { handsFree: 20 * 60_000, normal: 5 * 60_000 };

/**
 * Speech-to-speech session with OpenAI Realtime over WebRTC.
 * Audio goes browser <-> OpenAI directly; tool calls come back on the data channel and run on our server.
 */
export class RealtimeVoice implements VoiceEngine {
  readonly kind = 'realtime' as const;
  private meter?: LevelMeter;
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  private audio = new Audio();
  private lastUserText = '';
  private followUntil = 0;
  private lastActivity = Date.now();
  private idleTimer?: number;
  private name = '';
  private responding = false;

  constructor(
    private h: VoiceHandlers,
    private handsFree: boolean,
  ) {
    this.audio.autoplay = true;
  }

  async start(): Promise<void> {
    this.h.onStatus('connecting');
    const session = await api.post<SessionInfo>('/api/realtime/session', { handsFree: this.handsFree });
    this.name = session.assistantName;

    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.meter = new LevelMeter();
    this.meter.addStream(this.mic);
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => {
      this.audio.srcObject = e.streams[0] ?? null;
      if (e.streams[0]) this.meter?.addStream(e.streams[0]);
    };
    for (const track of this.mic.getTracks()) pc.addTrack(track, this.mic);

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (m) => void this.onEvent(JSON.parse(m.data));
    dc.onopen = () => {
      this.h.onStatus('listening');
      if (session.greet)
        this.send({
          type: 'response.create',
          response: { instructions: 'Привітайся коротко і дай брифінг дня у 2–3 реченнях СТРОГО за блоком «СЬОГОДНІ» і «ДЖЕРЕЛА ДАНИХ». Чого там немає — не згадуй; якщо джерела не підключені, так і скажи одним реченням.' },
        });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(session.model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: { authorization: `Bearer ${session.value}`, 'content-type': 'application/sdp' },
    });
    if (!res.ok) {
      const body = await res.text();
      this.stop();
      // the OpenAI project has no access to Realtime models: the caller switches to the standard voice mode
      if (res.status === 403 || res.status === 404 || /model_not_found/.test(body)) throw new RealtimeUnavailable(body.slice(0, 200));
      throw new Error(`OpenAI Realtime: ${res.status} ${body.slice(0, 200)}`);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

    this.idleTimer = window.setInterval(() => {
      const limit = this.handsFree ? IDLE_STOP_MS.handsFree : IDLE_STOP_MS.normal;
      if (Date.now() - this.lastActivity > limit) {
        this.h.onLine('system', 'Сесію завершено через тишу.');
        this.stop();
      }
    }, 30_000);
  }

  stop(): void {
    window.clearInterval(this.idleTimer);
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.meter?.close();
    this.audio.srcObject = null;
    this.pc = undefined;
    this.dc = undefined;
    this.h.onStatus('idle');
  }

  setMuted(muted: boolean): void {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  get active(): boolean {
    return Boolean(this.pc);
  }

  level(): number {
    return this.meter?.level() ?? 0;
  }

  /** Proactive message from the server: the assistant says it in its own words. */
  announce(text: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `Проактивне нагадування для власника, скажи коротко своїми словами: ${text}` }] },
    });
    this.send({ type: 'response.create' });
    this.followUntil = Date.now() + FOLLOW_UP_MS * 2;
  }

  private send(ev: unknown): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  }

  private async onEvent(ev: any): Promise<void> {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.lastActivity = Date.now();
        this.h.onStatus('hearing');
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(ev.transcript ?? '').trim();
        if (!text) break;
        this.lastUserText = text;
        this.h.onLine('user', text);
        void api.post('/api/realtime/transcript', { role: 'user', text }).catch(() => {});
        if (this.handsFree) {
          if (isAddressed(text, this.name) || Date.now() < this.followUntil) {
            if (!this.responding) this.send({ type: 'response.create' });
          } else this.h.onStatus('listening');
        }
        break;
      }
      case 'response.created':
        this.responding = true;
        this.h.onStatus('thinking');
        break;
      case 'output_audio_buffer.started':
        this.h.onStatus('speaking');
        break;
      case 'output_audio_buffer.stopped':
        this.followUntil = Date.now() + FOLLOW_UP_MS;
        this.h.onStatus('listening');
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = String(ev.transcript ?? '').trim();
        if (text) {
          this.h.onLine('assistant', text);
          void api.post('/api/realtime/transcript', { role: 'assistant', text }).catch(() => {});
        }
        break;
      }
      case 'response.done': {
        this.responding = false;
        const calls = (ev.response?.output ?? []).filter((o: any) => o.type === 'function_call');
        if (!calls.length) break;
        this.h.onStatus('thinking');
        for (const c of calls) {
          let output = '{"status":"error"}';
          try {
            const r = await api.post<{ output: string; proposals: Proposal[] }>('/api/realtime/tool', {
              name: c.name,
              arguments: c.arguments,
              lastUserText: this.lastUserText,
            });
            output = r.output;
            if (r.proposals.length) this.h.onProposals(r.proposals);
          } catch (e) {
            output = JSON.stringify({ status: 'error', note: e instanceof Error ? e.message : String(e) });
          }
          this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output } });
        }
        this.send({ type: 'response.create' });
        break;
      }
      case 'error':
        this.h.onError(ev.error?.message ?? 'Помилка голосової сесії');
        break;
    }
  }
}
