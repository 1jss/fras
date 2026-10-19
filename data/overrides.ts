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

  // Pronoun/function-word forms where NST's first variant is not the everyday
  // spoken form.
  han: ['"han'], // short a: /han/, not /hɑːn/
  dig: ['"dEj'], // /dɛj/, not /diːɡ/

  // Homographs where the automatic "common reading" ranking still picks the
  // wrong NST entry for running text.
  nåt: ['"no:t'],
  dans: ['"dans'],
  sida: ['""si:$da'],
  kors: ['"kOs`'],
  hals: ['"hals'],
  skott: ['"skOt'],
  kurs: ['"ku0s`'],
  rykte: ['""rYk$te'],
  rest: ['"rEst'],
  vars: ['"vA:s`'],
  syntes: ['sYn$"te:s'], // the noun (synthesis), not the rare past tense of "synas"
  "östgöta": ['""9st$%j2:$ta'],
  // The given name Mats is far more common than the genitive "mats" (food's).
  mats: ['"mats'],
};
