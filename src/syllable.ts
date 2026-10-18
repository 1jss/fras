/**
 * Minimal syllable segmentation for rule-derived transcriptions.
 *
 * Operates on an unstressed NST SAMPA segment string and inserts `$` before
 * each syllable after the first. The last consonant before a vowel is treated
 * as that syllable's onset (maximum-onset-ish), which matches the common cases
 * in the NST lexicon (gata, människa, kasta). Exact boundaries are not critical
 * for synthesis — the voice adapter drops `$` — but they matter for stress.
 */

import { isVowel, parseNst, type NstPhoneme } from "./sampa.ts";

export function phonemeList(segments: string): string[] {
  return parseNst(segments)
    .filter((t) => t.type === "phoneme")
    .map((t) => t.symbol);
}

/** Insert `$` syllable boundaries into an unstressed NST SAMPA string. */
export function syllabify(segments: string): string {
  const phonemes = phonemeList(segments);
  if (phonemes.length === 0) return segments;

  const vowelIdx: number[] = [];
  phonemes.forEach((p, i) => {
    if (isVowel(p as NstPhoneme)) vowelIdx.push(i);
  });
  if (vowelIdx.length <= 1) return phonemes.join("");

  const boundaries = new Set<number>();
  let prevVowel = vowelIdx[0]!;
  for (let k = 1; k < vowelIdx.length; k += 1) {
    const v = vowelIdx[k]!;
    // Onset = the single consonant directly before the vowel (if any).
    const onset = v - 1 > prevVowel ? v - 1 : v;
    boundaries.add(onset);
    prevVowel = v;
  }

  let out = "";
  for (let i = 0; i < phonemes.length; i += 1) {
    if (boundaries.has(i) && i !== 0) out += "$";
    out += phonemes[i];
  }
  return out;
}

/** Remove all stress marks from a transcription. */
export function stripStress(s: string): string {
  return s.replace(/""|"|%/g, "");
}

/**
 * Place stress marks. `primary` is the syllable index that gets primary stress;
 * any other listed indices get secondary stress. Accent II uses `""`.
 */
export function assignStress(
  syllables: string,
  primary = 0,
  accent2 = false,
  secondary: number[] = [],
): string {
  const parts = syllables.split("$");
  const secondarySet = new Set(secondary);
  return parts
    .map((part, i) => {
      if (i === primary) return (accent2 ? '""' : '"') + part;
      if (secondarySet.has(i)) return "%" + part;
      return part;
    })
    .join("$");
}

export function syllableCount(syllables: string): number {
  return syllables.split("$").length;
}
