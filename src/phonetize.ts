/**
 * The phonetization pipeline: word -> canonical NST SAMPA, and text -> IPA.
 *
 * Order of resolution for a word:
 *   1. lexicon lookup (full NST, all variants preserved);
 *   2. morphology (compound split / suffix stripping, lexicon-backed);
 *   3. generic rules (letter-to-sound).
 *
 * The canonical output is NST SAMPA. Use {@link wordToIpa} / {@link textToIpa}
 * to render it in the alphabet a Piper voice can voice.
 */

import { applyRules } from "./rules/engine.ts";
import { SV_RULES_COMPILED } from "./rules/sv-rules.ts";
import { lexicon as defaultLexicon, type Lexicon } from "./lexicon.ts";
import { morphological } from "./morphology.ts";
import { OVERRIDES } from "../data/overrides.ts";
import { assignStress, syllabify } from "./syllable.ts";
import { toVoiceIpa, SV_PROFILE, type VoiceProfile } from "./to-voice-ipa.ts";
import { tokenize, type Token } from "./tokenize.ts";

export type PhonemeSource = "override" | "lexicon" | "morphology" | "rules" | "g2p";

export interface PhonetizeOptions {
  /** Lexicon to use; `null` disables lookup. Defaults to the built-in lexicon. */
  lexicon?: Lexicon | null;
  /** Enable the curated override table (default true). */
  overrides?: boolean;
  /** Enable the generic rule layer (default true). */
  rules?: boolean;
  /** Enable the morphological fallback (default true). */
  morphology?: boolean;
  /** Replace the whole pipeline with a custom G2P (e.g. a learned model). */
  g2p?: G2P;
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
  if (opts.g2p) {
    return { word, variants: opts.g2p.phonetize(word), source: "g2p" };
  }

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

  if (lex && (opts.morphology ?? true)) {
    const morph = morphological(word, lex);
    if (morph) {
      return { word, variants: morph.variants, source: "morphology", via: morph.via };
    }
  }

  if (opts.rules ?? true) {
    const segments = applyRules(word, SV_RULES_COMPILED);
    const syllabified = syllabify(segments);
    return { word, variants: [assignStress(syllabified, 0)], source: "rules" };
  }

  return { word, variants: [], source: "rules" };
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

/**
 * The pluggable grapheme-to-phoneme seam.
 *
 * Rules, lexicon and a future learned/compressed model are interchangeable
 * implementations: all that is required is to return canonical NST SAMPA for a
 * word. The NST lexicon doubles as the training/validation set (`npm run eval`).
 */
export interface G2P {
  /** Canonical NST SAMPA variants for a word, best first. */
  phonetize(word: string): string[];
}

/** Default G2P: overrides + lexicon + morphology + rules. */
export const defaultG2P: G2P = {
  phonetize(word: string): string[] {
    return phonetizeWord(word).variants;
  },
};