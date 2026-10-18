/**
 * Morphological fallback: reuse lexicon entries for inflected and compound
 * words that are not themselves in the lexicon.
 *
 * Two strategies, in order:
 *   1. compound split — both halves found in the lexicon;
 *   2. suffix stripping — a stem in the lexicon plus a known ending.
 *
 * The result is still canonical NST SAMPA. This is how fras stretches the
 * lexicon over inflections and compounds without hand-coding every form.
 */

import type { Lexicon } from "./lexicon.ts";
import { assignStress, stripStress, syllableCount } from "./syllable.ts";

/** Common endings and their NST SAMPA, longest first. */
export const SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["heterna", "he:$tEr$na"],
  ["heternas", "he:$tEr$nas"],
  ["heterna", "he:$tEr$na"],
  ["heternas", "he:$tEr$nas"],
  ["hetens", "he:$tEns"],
  ["heten", "he:$tEn"],
  ["heter", "he:$tEr"],
  ["arnas", "a$nas"],
  ["ernas", "Er$nas"],
  ["ornas", "Ur$nas"],
  ["andet", "an$det"],
  ["anden", "an$den"],
  ["ande", "an$de"],
  ["ende", "En$de"],
  ["ning", "nIN"],
  ["ningens", "nIN$ens"],
  ["ningen", "nIN$en"],
  ["ningar", "nIN$ar"],
  ["arnas", "a$nas"],
  ["arna", "a$na"],
  ["erna", "Er$na"],
  ["orna", "Ur$na"],
  ["else", "El$se"],
  ["elsen", "El$sen"],
  ["elser", "El$ser"],
  ["tion", "x\\u:n"],
  ["tions", "x\\u:ns"],
  ["iskt", "Iskt"],
  ["iska", "Is$ka"],
  ["isk", "Isk"],
  ["ligt", "lIkt"],
  ["liga", "lI$ga"],
  ["lig", "lIg"],
  ["aste", "as$te"],
  ["are", "a$re"],
  ["ast", "ast"],
  ["ens", "ens"],
  ["ets", "ets"],
  ["ars", "ars"],
  ["ers", "ers"],
  ["ors", "Urs"],
  ["en", "en"],
  ["et", "et"],
  ["ar", "ar"],
  ["er", "er"],
  ["or", "Ur"],
  ["n", "n"],
  ["s", "s"],
  ["t", "t"],
  ["a", "a"],
  ["e", "e"],
];

export interface MorphResult {
  /** Canonical NST SAMPA. */
  variants: string[];
  /** Human-readable description of how it was derived. */
  via: string;
}

function combine(a: string, b: string): string {
  const s = stripStress(a) + "$" + stripStress(b);
  const n = syllableCount(s);
  return assignStress(s, 0, false, n > 1 ? [n - 1] : []);
}

/**
 * Try to derive `word` from the lexicon. Returns null when no strategy applies.
 */
export function morphological(word: string, lex: Lexicon): MorphResult | null {
  const w = word.toLowerCase();

  // 1. Compound split (longest first half first).
  for (let i = w.length - 2; i >= 2; i -= 1) {
    const head = w.slice(0, i);
    const tail = w.slice(i);
    if (tail.length < 2) continue;
    const a = lex.lookup(head);
    const b = lex.lookup(tail);
    if (a && b) {
      return { variants: [combine(a.variants[0]!, b.variants[0]!)], via: `compound:${head}+${tail}` };
    }
  }

  // 2. Suffix stripping.
  for (const [suf, phonemes] of SUFFIXES) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, w.length - suf.length);
    if (stem.length < 3) continue;
    const entry = lex.lookup(stem);
    if (entry) {
      const s = stripStress(entry.variants[0]!) + "$" + stripStress(phonemes);
      return { variants: [assignStress(s, 0)], via: `suffix:${stem}+${suf}` };
    }
  }

  return null;
}
