const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’'ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Hands-free mode: was the assistant called by name? Matches the vocative too
 * ("Аріна" -> "Аріно", "Джарвіс" -> "Джарвісе") by comparing the stem.
 */
export function isAddressed(transcript: string, name: string): boolean {
  const target = norm(name).join(' ');
  if (!target) return true;
  const words = norm(transcript);
  const stem = target.length > 4 ? target.slice(0, target.length - 1) : target;
  return words.some((w) => w === target || (stem.length >= 3 && w.startsWith(stem)));
}

/** Context for speech recognition: short Ukrainian answers and the assistant's name otherwise come out garbled. */
export function transcriptionHint(assistantName: string): string {
  return `Розмова українською з особистим асистентом ${assistantName}. Короткі відповіді: «Так», «Ні», «Підтверджую», «Скасуй», «Давай».`;
}

/**
 * On silence or noise the recogniser sometimes returns the context hint itself (or a stock phrase): that is not speech.
 */
export function isPhantomTranscript(text: string, assistantName: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  const flat = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const hint = flat(transcriptionHint(assistantName));
  const ft = flat(t);
  // any fragment of our own hint («Розмова українською…», «Так, Ні, Підтверджую…») is the recogniser talking, not the owner
  // (a single «так» / «давай» is a real answer, so only fragments of two words or more count)
  if (ft && ((ft.includes(' ') && hint.includes(ft)) || ft.includes('розмова українською'))) return true;
  return /^(дякую за перегляд|субтитри|продовження сліду|thank you for watching)[.!]*$/i.test(t);
}

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’'ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/**
 * Did the microphone just hear the assistant's own voice from the speakers?
 * Most words of the transcript appear in what the assistant said a moment ago.
 */
export function isEcho(transcript: string, assistantSaid: string | undefined): boolean {
  if (!assistantSaid) return false;
  const heard = words(transcript);
  if (heard.length < 2) return false;
  const said = new Set(words(assistantSaid));
  const hits = heard.filter((w) => said.has(w)).length;
  return hits / heard.length >= 0.6;
}

/** Worth answering: real words, not the recogniser's hint, not a lone filler. */
export function isMeaningful(transcript: string, assistantName: string): boolean {
  if (isPhantomTranscript(transcript, assistantName)) return false;
  const w = words(transcript);
  if (w.length === 0) return /^(так|ні|да|ок|ага)[.!?]*$/i.test(transcript.trim());
  return true;
}
