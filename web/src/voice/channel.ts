/**
 * Which voice channel the core uses on this device.
 * smart (default): our pipeline — speech → the same agent as chat (tools, Notion, memory, history) → ElevenLabs.
 * instant: OpenAI Realtime — answers in ~1 s, but a weaker model that seldom looks at the owner's data.
 */
export type VoiceChannel = 'smart' | 'instant';

const KEY = 'aia.voiceChannel';

export function voiceChannel(): VoiceChannel {
  try {
    return localStorage.getItem(KEY) === 'instant' ? 'instant' : 'smart';
  } catch {
    return 'smart';
  }
}

export function setVoiceChannel(c: VoiceChannel) {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* private mode: default stays */
  }
}
