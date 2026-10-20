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
  braxenToIpa,
  braxenToNstSampa,
  braxenVoiceIpa,
  braxenVoiceSegments,
  BRAXEN_BASE_TO_IPA,
  BRAXEN_BASE_TO_NST,
  NST_SAMPA_TO_IPA,
  type BraxenEntry,
  type BraxenToVoiceIpaOptions,
} from "./braxen.ts";
export {
  lexicon,
  fullLexicon,
  nstBaseline,
  parseLexicon,
  ruleIndex,
  parseRuleIndex,
  FULL_LEXICON_PATH,
  NST_BASELINE_PATH,
  BRAXEN_LEXICON_PATH,
  PRUNED_LEXICON_PATH,
  PRUNED_LEXICON_COMPACT_PATH,
  RULE_INDEX_PATH,
  RULE_INDEX_COMPACT_PATH,
  type Lexicon,
  type LexiconEntry,
  type RuleIndex,
  type RuleEntry,
} from "./lexicon.ts";
export {
  encodeCompactLexicon,
  encodeCompactRuleIndex,
  parseCompactLexicon,
  parseCompactRuleIndex,
} from "./compact.ts";
export { morphological, SUFFIXES, type MorphResult } from "./morphology.ts";
export { syllabify as syllabifySampa, stripStress, assignStress, syllableCount } from "./syllable.ts";
export { SV_RULES, SV_RULES_COMPILED } from "./rules/sv-rules.ts";
export {
  compileRules,
  applyRules,
  applyRulesTrace,
  type Rule,
  type RuleStep,
  type RuleTrace,
} from "./rules/engine.ts";
export {
  phonetize,
  phonetizeWord,
  phonetizeText,
  wordToIpa,
  textToIpa,
  applyStructureCorrection,
  phonemeSequence,
  type PhonetizeOptions,
  type PhonemeSource,
  type WordResult,
  type IpaToken,
  type G2P,
  defaultG2P,
} from "./phonetize.ts";
export { annotate, type AnnotateResult } from "./annotate.ts";
export { normalizeText, spellNumber } from "./normalize.ts";
export { piperPhonemes, piperBlocks, preload } from "./piper.ts";
