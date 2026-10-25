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

/** Native Ukrainian voices from the ElevenLabs library, picked for natural conversational delivery. */
export const ELEVEN_VOICES: Array<{ id: string; label: string }> = [
  { id: 'yMBZR4SLoc24wOJLWAB2', label: 'Соломія — жіночий, розмовний' },
  { id: 'nCqaTnIbLdME87OuQaZY', label: 'Віра — жіночий, природний' },
  { id: '96XEXOjZRHooATdYA8FY', label: 'Софія — жіночий, теплий' },
  { id: 'BEprpS2vpgM32yNJpTXq', label: 'Альона — жіночий, спокійний' },
  { id: 'h9NSQvWZaC4NFusYsxT9', label: 'Артем — чоловічий, глибокий' },
  { id: 'GVRiwBELe0czFUAJj0nX', label: 'Антон — чоловічий, дружній' },
  { id: 'Ntd0iVwICtUtA6Fvx27M', label: 'Євгеній — чоловічий, насичений' },
];

/** Delivery presets mapped onto ElevenLabs voice settings (same ids as VOICE_STYLES). */
const ELEVEN_STYLE: Record<string, { stability: number; similarity_boost: number; style: number }> = {
  natural: { stability: 0.45, similarity_boost: 0.8, style: 0.25 },
  calm: { stability: 0.65, similarity_boost: 0.8, style: 0.1 },
  energetic: { stability: 0.3, similarity_boost: 0.8, style: 0.5 },
  business: { stability: 0.75, similarity_boost: 0.85, style: 0 },
};

/**
 * ElevenLabs: the most human-sounding option. Two models for one voice:
 * `fast` for the live conversation (streamed, ~0.15-0.45 s to first sound), `quality` for Telegram
 * voice notes, briefings and previews where an extra half second does not matter.
 */
export class ElevenLabs implements Tts {
  constructor(
    private apiKey: string,
    private models: { fast: string; quality: string },
    private choice: () => Promise<VoiceChoice>,
  ) {}

  private async body(text: string, model: string, override?: Partial<VoiceChoice>) {
    const c = { ...(await this.choice()), ...override };
    return { voice: c.voice, json: { text, model_id: model, voice_settings: { ...(ELEVEN_STYLE[c.style] ?? ELEVEN_STYLE.natural!), use_speaker_boost: true } } };
  }

  async speak(text: string, override?: Partial<VoiceChoice>): Promise<Uint8Array> {
    const b = await this.body(text, this.models.quality, override);
    const res = await http(`https://api.elevenlabs.io/v1/text-to-speech/${b.voice}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, accept: 'audio/mpeg' },
      query: { output_format: 'mp3_44100_128' },
      json: b.json,
      timeoutMs: 90_000,
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  async streamPcm(text: string, onChunk: (pcm: Uint8Array) => void): Promise<void> {
    const b = await this.body(text, this.models.fast);
    const res = await http(`https://api.elevenlabs.io/v1/text-to-speech/${b.voice}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      query: { output_format: 'pcm_24000' },
      json: b.json,
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
