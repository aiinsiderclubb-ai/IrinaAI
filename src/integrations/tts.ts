import { spawn } from 'node:child_process';
import { http } from '../lib/http.js';

export interface Tts {
  /** mp3 bytes */
  speak(text: string): Promise<Uint8Array>;
  /** low-latency: raw PCM 24 kHz, 16-bit little-endian mono, delivered while it is being synthesised */
  streamPcm?(text: string, onChunk: (pcm: Uint8Array) => void): Promise<void>;
}

/** Reads a streamed body and hands out even-length (whole 16-bit samples) chunks of at least ~100 ms. */
async function pumpPcm(res: Response, onChunk: (pcm: Uint8Array) => void): Promise<void> {
  if (!res.body) throw new Error('empty audio stream');
  const reader = res.body.getReader();
  const MIN = 4800; // 100 ms at 24 kHz * 2 bytes
  let pending = new Uint8Array(0);
  const take = (all: boolean) => {
    const n = all ? pending.length - (pending.length % 2) : pending.length - (pending.length % 2);
    if (n <= 0 || (!all && n < MIN)) return;
    onChunk(pending.slice(0, n));
    pending = pending.slice(n);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(pending.length + value.length);
    merged.set(pending);
    merged.set(value, pending.length);
    pending = merged;
    take(false);
  }
  take(true);
}

export class ElevenLabs implements Tts {
  constructor(
    private apiKey: string,
    private voiceId: string,
    private model: string,
  ) {}

  async speak(text: string): Promise<Uint8Array> {
    const res = await http(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, accept: 'audio/mpeg' },
      query: { output_format: 'mp3_44100_64' },
      json: { text, model_id: this.model },
      timeoutMs: 90_000,
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  async streamPcm(text: string, onChunk: (pcm: Uint8Array) => void): Promise<void> {
    const res = await http(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      query: { output_format: 'pcm_24000', optimize_streaming_latency: 3 },
      json: { text, model_id: this.model },
      timeoutMs: 90_000,
    });
    await pumpPcm(res, onChunk);
  }
}

/** Telegram `sendVoice` needs OGG/Opus. Returns null when ffmpeg is unavailable (caller falls back to mp3 audio). */
export function toOggOpus(mp3: Uint8Array): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1']);
    const chunks: Buffer[] = [];
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(Buffer.from(mp3));
  });
}

/** Strips markup so the voice does not read tags / asterisks. */
export function plainForSpeech(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** OpenAI voices usable with gpt-4o-mini-tts (labels for the settings screen). */
export const OPENAI_VOICES: Array<{ id: string; label: string }> = [
  { id: 'marin', label: 'Marin — жіночий, спокійний' },
  { id: 'coral', label: 'Coral — жіночий, теплий' },
  { id: 'sage', label: 'Sage — жіночий, м’який' },
  { id: 'shimmer', label: 'Shimmer — жіночий, світлий' },
  { id: 'nova', label: 'Nova — жіночий, бадьорий' },
  { id: 'cedar', label: 'Cedar — чоловічий, глибокий' },
  { id: 'ballad', label: 'Ballad — чоловічий, оксамитовий' },
  { id: 'verse', label: 'Verse — чоловічий, живий' },
  { id: 'ash', label: 'Ash — чоловічий, рівний' },
];

/** Delivery presets: gpt-4o-mini-tts follows free-text instructions on how to speak. */
export const VOICE_STYLES: Record<string, { label: string; instructions: string }> = {
  natural: {
    label: 'Природна розмова',
    instructions:
      'Говори як жива людина в дружній розмові, а не як диктор. Природні паузи, легкі зміни інтонації, теплота і легка усмішка в голосі. Помірний, невимушений темп. Чиста українська вимова з правильними наголосами.',
  },
  calm: {
    label: 'Спокійна, впевнена',
    instructions:
      'Говори спокійно і впевнено, як досвідчений особистий асистент: рівний темп, м’які паузи між думками, без поспіху і без пафосу. Чиста українська вимова з правильними наголосами.',
  },
  energetic: {
    label: 'Енергійна',
    instructions:
      'Говори бадьоро і з ентузіазмом, як друг, який радий допомогти: жвавий темп, виразні інтонації, але без крику. Чиста українська вимова з правильними наголосами.',
  },
  business: {
    label: 'Ділова, коротка',
    instructions:
      'Говори чітко і по-діловому, як топ-асистент керівника: зібрано, без зайвих емоцій, з короткими паузами. Чиста українська вимова з правильними наголосами.',
  },
};

export interface VoiceChoice {
  voice: string;
  style: string;
}

/**
 * OpenAI speech (works with the client's existing OpenAI key; ElevenLabs is optional).
 * Voice and delivery come from settings on every call, so a change in the cabinet applies immediately.
 */
export class OpenAiTts implements Tts {
  constructor(
    private apiKey: string,
    private model = 'gpt-4o-mini-tts',
    private choice: () => Promise<VoiceChoice> = async () => ({ voice: 'marin', style: 'natural' }),
  ) {}

  private async request(text: string, format: 'mp3' | 'pcm', override?: Partial<VoiceChoice>) {
    const c = { ...(await this.choice()), ...override };
    return http('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      json: {
        model: this.model,
        voice: c.voice,
        input: text.slice(0, 3800),
        instructions: (VOICE_STYLES[c.style] ?? VOICE_STYLES.natural!).instructions,
        response_format: format,
      },
      timeoutMs: 60_000,
    });
  }

  async speak(text: string, override?: Partial<VoiceChoice>): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(text, 'mp3', override)).arrayBuffer());
  }

  async streamPcm(text: string, onChunk: (pcm: Uint8Array) => void): Promise<void> {
    await pumpPcm(await this.request(text, 'pcm'), onChunk);
  }
}
