/**
 * Compatibility output: rewrite text so every word becomes a Piper
 * raw-phoneme block (`[[ IPA ]]`).
 *
 * This lets fras drive an unmodified Piper server (espeak-ng never phonetizes a
 * word). Non-word runs — spaces and punctuation — are left in place; a Piper
 * server still routes those through espeak for sentence terminators, which is
 * why the raw-phoneme endpoint (`phonetizeText`) is the fully espeak-free path.
 */

import {
  phonetizeText,
  type PhonetizeOptions,
} from "./phonetize.ts";
import { SV_PROFILE, type VoiceProfile } from "./to-voice-ipa.ts";

export interface AnnotateResult {
  /** Text with each word wrapped in `[[ …IPA… ]]`. */
  text: string;
  /** Number of words wrapped. */
  hits: number;
  /** Number of words with no phonemes (left untouched). */
  misses: number;
}

export function annotate(
  text: string,
  opts: PhonetizeOptions = {},
  profile: VoiceProfile = SV_PROFILE,
): AnnotateResult {
  let out = "";
  let hits = 0;
  let misses = 0;
  for (const token of phonetizeText(text, opts, profile)) {
    if (token.kind === "other") {
      out += token.text;
      continue;
    }
    if (token.ipa) {
      out += `[[${token.ipa}]]`;
      hits += 1;
    } else {
      out += token.text;
      misses += 1;
    }
  }
  return { text: out, hits, misses };
}
