/**
 * fras — Swedish phonetization for Piper.
 *
 * ```ts
 * import { textToIpa, annotate, phonetizeWord } from "fras";
 *
 * textToIpa("Hej på dig!");        // IPA in the voices' alphabet
 * annotate("Hej på dig!").text;    // "[[…]]" raw-phoneme blocks for Piper
 * phonetizeWord("kärlek");         // canonical NST SAMPA + provenance
 * ```
 */

export { tokenize, type Token } from "./tokenize.ts";
export {
  parseNst,
  syllabify,
  nucleusCount,
  isVowel,
  NST_PHONEMES,
  type NstToken,
  type NstTokenType,
  type NstSyllable,
  type NstPhoneme,
  type Stress,
} from "./sampa.ts";
export {
  toVoiceIpa,
  profileSymbols,
  SV_PROFILE,
  SV_VOICE_MAP,
  type VoiceProfile,
  type ToVoiceIpaOptions,
} from "./to-voice-ipa.ts";
export {
  lexicon,
  parseLexicon,
  type Lexicon,
  type LexiconEntry,
} from "./lexicon.ts";
export { morphological, SUFFIXES, type MorphResult } from "./morphology.ts";
export { syllabify as syllabifySampa, stripStress, assignStress, syllableCount } from "./syllable.ts";
export { SV_RULES, SV_RULES_COMPILED } from "./rules/sv-rules.ts";
export { compileRules, applyRules, type Rule } from "./rules/engine.ts";
export {
  phonetize,
  phonetizeWord,
  phonetizeText,
  wordToIpa,
  textToIpa,
  type PhonetizeOptions,
  type PhonemeSource,
  type WordResult,
  type IpaToken,
  type G2P,
  defaultG2P,
} from "./phonetize.ts";
export { annotate, type AnnotateResult } from "./annotate.ts";
