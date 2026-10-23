/**
 * The phonetization pipeline: word -> canonical NST SAMPA, and text -> IPA.
 *
 * Order of resolution for a word:
 *   1. curated overrides;
 *   2. lexicon lookup (production/pruned NST, preferred pronunciation);
 *   3. morphology (compound split / suffix stripping, lexicon-backed);
 *   4. generic rules (letter-to-sound), plus a stress/boundary correction for
 *      words the rules already cover phonemically.
 *
 * The canonical output is NST SAMPA. Use {@link wordToIpa} / {@link textToIpa}
 * to render it in the alphabet a Piper voice can voice.
 */

import { applyRules } from "./rules/engine.ts";
import { SV_RULES_COMPILED } from "./rules/sv-rules.ts";
import {
  lexicon as defaultLexicon,
  ruleIndex as defaultRuleIndex,
  type Lexicon,
  type RuleEntry,
} from "./lexicon.ts";
import { morphological } from "./morphology.ts";
import { OVERRIDES } from "../data/overrides.ts";
import { assignStress, syllabify } from "./syllable.ts";
import { parseNst } from "./sampa.ts";
import { toVoiceIpa, SV_PROFILE, type VoiceProfile } from "./to-voice-ipa.ts";
import { tokenize, type Token } from "./tokenize.ts";

export type PhonemeSource = "override" | "lexicon" | "morphology" | "rules";

export interface PhonetizeOptions {
  /** Lexicon to use; `null` disables lookup. Defaults to the built-in lexicon. */
  lexicon?: Lexicon | null;
  /** Enable the curated override table (default true). */
  overrides?: boolean;
  /** Enable the generic rule layer (default true). */
  rules?: boolean;
  /** Enable the morphological fallback (default true). */
  morphology?: boolean;
  /**
   * Route rule-covered words (the rule index) to the rule layer, skipping
   * morphology, and apply their structure correction (default true). Only used
   * with the built-in lexicon — an injected `lexicon` takes over resolution.
   */
  ruleIndex?: boolean;
}

export interface WordResult {
  word: string;
  /** Canonical NST SAMPA variants (first is preferred). */
  variants: string[];
  source: PhonemeSource;
  /** Present when `source === "morphology"`. */
  via?: string;
}

function resolveLexicon(opts: PhonetizeOptions): Lexicon | null {
  if (opts.lexicon !== undefined) return opts.lexicon;
  return defaultLexicon();
}

/** Phonetize a single word into canonical NST SAMPA. */
export function phonetizeWord(word: string, opts: PhonetizeOptions = {}): WordResult {
  if (opts.overrides ?? true) {
    const override = OVERRIDES[word.toLowerCase()];
    if (override && override.length > 0) {
      return { word, variants: [...override], source: "override" };
    }
  }

  const lex = resolveLexicon(opts);

  if (lex) {
    const entry = lex.lookup(word);
    if (entry) {
      return { word, variants: entry.variants, source: "lexicon" };
    }
  }

  // Rule-covered words: use the rules, not morphology. The rule index only applies
  // to the built-in (production) lexicon; injecting a lexicon takes over resolution.
  if (opts.lexicon === undefined && (opts.ruleIndex ?? true)) {
    const ruleEntry = defaultRuleIndex().lookup(word);
    if (ruleEntry) return rulesResult(word, opts, ruleEntry);
  }

  if (lex && (opts.morphology ?? true)) {
    const morph = morphological(word, lex);
    if (morph) {
      return { word, variants: morph.variants, source: "morphology", via: morph.via };
    }
  }

  if (opts.rules ?? true) {
    return rulesResult(word, opts, null);
  }

  return { word, variants: [], source: "rules" };
}

/** Run the rule layer, optionally restoring NST's structure for an indexed word. */
function rulesResult(
  word: string,
  opts: PhonetizeOptions,
  entry: RuleEntry | null,
): WordResult {
  if (!(opts.rules ?? true)) return { word, variants: [], source: "rules" };
  const segments = applyRules(word, SV_RULES_COMPILED);
  const out = assignStress(syllabify(segments), 0);
  const corrected =
    entry && entry.prefixes.length ? applyStructureCorrection(out, entry.prefixes) : out;
  return { word, variants: [corrected], source: "rules" };
}

/**
 * Re-render a transcription with NST's structure.
 *
 * `prefixes` gives the structure tokens (`$`, stress, `¤`, `_`) that precede each
 * phoneme index; the rule output's own syllables/stress are discarded and the
 * phonemes are re-emitted with NST's layout.
 */
export function applyStructureCorrection(
  transcription: string,
  prefixes: Array<[number, string]>,
): string {
  if (prefixes.length === 0) return transcription;
  const phonemes = parseNst(transcription)
    .filter((t) => t.type === "phoneme")
    .map((t) => t.symbol);
  const byIndex = new Map(prefixes);
  let out = "";
  for (let i = 0; i < phonemes.length; i += 1) {
    out += byIndex.get(i) ?? "";
    out += phonemes[i]!;
  }
  return out;
}

/** Phonemes only, order-preserving; used for rule-coverage comparison. */
export function phonemeSequence(s: string): string {
  return parseNst(s)
    .filter((t) => t.type === "phoneme")
    .map((t) => t.symbol)
    .join("");
}

/** Preferred canonical variant of a word (or "" if none). */
export function phonetize(word: string, opts: PhonetizeOptions = {}): string {
  return phonetizeWord(word, opts).variants[0] ?? "";
}

/** Render one word as the voice's IPA. */
export function wordToIpa(
  word: string,
  opts: PhonetizeOptions = {},
  profile: VoiceProfile = SV_PROFILE,
): string {
  const nst = phonetize(word, opts);
  return nst ? toVoiceIpa(nst, { profile }) : "";
}

export interface IpaToken {
  kind: "word" | "other";
  text: string;
  /** IPA for word tokens, "" for other tokens. */
  ipa: string;
  source?: PhonemeSource;
}

/** Phonetize text into per-token IPA. */
export function phonetizeText(
  text: string,
  opts: PhonetizeOptions = {},
  profile: VoiceProfile = SV_PROFILE,
): IpaToken[] {
  return tokenize(text).map((t: Token): IpaToken => {
    if (t.kind === "other") return { kind: "other", text: t.text, ipa: "" };
    const res = phonetizeWord(t.text, opts);
    const nst = res.variants[0];
    const ipa = nst ? toVoiceIpa(nst, { profile }) : "";
    return { kind: "word", text: t.text, ipa, source: res.source };
  });
}

/** Full IPA for a text, words separated by spaces, punctuation preserved. */
export function textToIpa(
  text: string,
  opts: PhonetizeOptions = {},
  profile: VoiceProfile = SV_PROFILE,
): string {
  return phonetizeText(text, opts, profile)
    .map((t) => (t.kind === "word" ? t.ipa : t.text))
    .join("");
}