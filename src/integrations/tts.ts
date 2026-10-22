import { spawn } from 'node:child_process';
import { http } from '../lib/http.js';

export interface Tts {
  /** mp3 bytes */
  speak(text: string): Promise<Uint8Array>;
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
