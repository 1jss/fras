/**
 * Piper edge adapter: text -> one pre-phonetized raw-phoneme block.
 *
 * Piper's embedded espeak-ng phonetizes any text that is not inside a
 * `[[ …IPA… ]]` block. By phonetizing *every* word with fras and normalizing the
 * remaining punctuation to symbols the Swedish voices can map, the whole
 * utterance can be handed to Piper as a single block, so espeak-ng never
 * phonetizes anything.
 *
 * Two consequences:
 *
 * - the block must speak the phoneme inventory the voices were trained on (fras
 *   already does: `r` + `t/d/l/n`, never `ʈ ɖ ɭ ɳ`, and `ʃ`, never `ɧ`), so no
 *   post-processing like `tools/piper_patch.py` is needed;
 * - characters the voices' `phoneme_id_map` does not contain are dropped, so
 *   typographic punctuation is mapped to a safe equivalent first.
 */

import { lexicon, ruleIndex } from "./lexicon.ts";
import { normalizeText } from "./normalize.ts";
import { phonetizeText, type PhonetizeOptions } from "./phonetize.ts";
import { SV_PROFILE, type VoiceProfile } from "./to-voice-ipa.ts";

/** Punctuation present in the Swedish voices' `phoneme_id_map`. */
const SAFE_PUNCT = new Set([".", ",", ";", ":", "?", "!", "'", "(", ")", "-", " "]);

/** Typographic / invisible characters -> safe equivalent ("" drops the char). */
const PUNCT_MAP: Readonly<Record<string, string>> = {
  "\u2019": "'", // ’ right single quote
  "\u2013": ",", // – en dash
  "\u2014": ",", // — em dash
  "\u2026": ".", // … ellipsis
  "\u00ad": "", // soft hyphen
};

function safePunctuation(text: string): string {
  let out = "";
  for (const ch of text) {
    if (SAFE_PUNCT.has(ch)) {
      out += ch;
      continue;
    }
    const mapped = PUNCT_MAP[ch];
    if (mapped !== undefined) out += mapped;
    // Anything else (quotes, brackets, unknown symbols) is dropped.
  }
  return out;
}

/**
 * Phonetize `text` into the voice's IPA as one utterance.
 *
 * Numbers and abbreviations are spelled out first, then every word is phonetized
 * and the surrounding punctuation is reduced to the voices' safe set. Returns
 * `""` when there is nothing to speak.
 */
export function piperPhonemes(
  text: string,
  opts: PhonetizeOptions = {},
  profile: VoiceProfile = SV_PROFILE,
): string {
  const normalized = normalizeText(text);
  let out = "";
  for (const token of phonetizeText(normalized, opts, profile)) {
    out += token.kind === "word" ? token.ipa : safePunctuation(token.text);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * `piperPhonemes(text)` wrapped in a Piper raw-phoneme block (`[[ …IPA… ]]`), or
 * `""` when the text has nothing speakable. Pass the result to Piper verbatim.
 */
export function piperBlocks(
  text: string,
  opts: PhonetizeOptions = {},
  profile: VoiceProfile = SV_PROFILE,
): string {
  const phonemes = piperPhonemes(text, opts, profile);
  return phonemes ? `[[${phonemes}]]` : "";
}

/**
 * Force the lazy resources (lexicon, rule index) to load, so the first real
 * synthesis isn't delayed. Rules are compiled on import.
 */
export function preload(): void {
  lexicon();
  ruleIndex();
}
