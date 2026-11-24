import type { Voice } from 'expo-speech';

// These are known English voice IDs from Google's Android engine. Android's Voice API has no gender field.
const familiarVoices = [
  'en-in-x-ahp-local', 'en-in-x-cxx-local', 'en-in-x-enc-local', 'en-in-x-ena-local',
  'en-gb-x-fis-local', 'en-gb-x-gba-local', 'en-us-x-tpf-local', 'en-us-x-tpc-local',
];

export function chooseEnglishVoice(voices: readonly Voice[]) {
  let best: Voice | undefined;
  let bestScore = -1;
  for (const voice of voices) {
    if (!/^en(?:[-_]|$)/i.test(voice.language)) continue;
    const id = voice.identifier.toLowerCase();
    if (id.endsWith('-network') || !id) continue;
    const rank = familiarVoices.indexOf(id);
    const feminine = rank >= 0 || /\bfemale\b/i.test(voice.name + ' ' + id);
    const score = (feminine ? 100 : 0) + (voice.quality === 'Enhanced' ? 20 : 0)
      + (rank < 0 ? 0 : familiarVoices.length - rank) + (id.endsWith('-local') ? 2 : 0);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

export function speechChunks(text: string, limit: number) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const sentence = Array.from(window.matchAll(/[.!?;:](?=\s)|\n/g)).at(-1)?.index ?? -1;
    const word = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
    const end = sentence >= limit / 3 ? Math.min(limit, sentence + 1) : word > 0 ? word : limit;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
