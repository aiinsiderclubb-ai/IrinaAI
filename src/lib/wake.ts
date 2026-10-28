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
  const hint = transcriptionHint(assistantName).toLowerCase();
  if (hint.includes(t) || t.includes('розмова українською з особистим асистентом')) return true;
  return /^(дякую за перегляд|субтитри|продовження сліду|thank you for watching)[.!]*$/i.test(t);
}
