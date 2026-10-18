/**
 * Hand-curated word overrides — the highest-priority layer.
 *
 * The NST lexicon is comprehensive but omits a number of very common Swedish
 * function words (`det`, `den`, `som`, `av`, `på`, ...), and a few spellings
 * need a pronunciation the lexicon's default variant does not capture. Entries
 * here are canonical **NST SAMPA** and win over both the lexicon and the rules.
 *
 * Keys are lowercase. Values are variants, best first.
 */

export const OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  // Function words missing from NST (standard spoken pronunciations).
  det: ['"de:'], // silent t: /deː/
  den: ['"dEn'],
  som: ['"sOm'],
  efter: ['"Ef$ter'],
  av: ['"A:v'],
  på: ['"po:'],
  "någon": ['""no:$gOn'],
  "några": ['""no:$gra'],

  // Spoken standard for the pronoun "de" (they): /dɔm/.
  de: ['"dOm'],
};
