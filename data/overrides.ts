/**
 * Hand-curated word overrides — the highest-priority layer.
 *
 * The merged lexicon is **Braxen-first** (with an NST full-word fallback). Braxen
 * now supplies the common function words NST omitted (`det`, `den`, `som`, `av`,
 * `på`, `de`, `han`, `dig`, ...) and the homograph readings this table used to
 * correct (`rest`, `syntes`, `mats`, `dans`, `hals`, `skott`, `kurs`, `kors`,
 * `östgöta`), so those entries were removed. Braxen's schwa and secondary-stress
 * notation (`efter` -> `ˈɛftər`, `rykte` -> `rˈʏktˌə`) is kept as-is — that is
 * exactly the kind of difference the NST-vs-Braxen audition preferred.
 *
 * What remains are the cases where Braxen's default reading is still wrong for
 * running text. Entries are canonical **NST SAMPA** and win over both the lexicon
 * and the rules.
 *
 * Keys are lowercase. Values are variants, best first.
 */

export const OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  // Braxen drops the `g` (`n "o: . r ,a` -> /ˈnoːrˌa/); the standard form keeps it.
  "några": ['""no:$gra'],

  // Braxen's preferred row is short /nɔt/; the established spoken form is long.
  "nåt": ['"no:t'],

  // Braxen's preferred row is an odd `IN` reading /vaʂ/; the noun /vɑːʂ/ is the
  // everyday reading.
  vars: ['"vA:s`'],

  // Braxen ranks the noun `kan` (khan, /kɑːn/) above the verb `kan` (can, /kan/)
  // because the POS order prefers nouns. In running text the verb dominates and
  // NST already has the short reading, so restore it.
  kan: ['"kan'],
};
