/**
 * Hand-curated word overrides — the highest-priority layer.
 *
 * The merged lexicon is **Braxen-first** (with an NST full-word fallback) and the
 * reading stored for a homograph is chosen by **usage** (the POS-conditioned
 * frequency table; `tools/build-braxen-lexicon.ts`). That resolves the everyday
 * readings this table used to carry: Braxen supplies the common function words
 * NST omitted (`det`, `den`, `som`, `av`, `på`, `de`, `han`, `dig`, ...), and
 * usage picks the verb over the rare noun for `kan`, `var`, `drog`, `bor`, `läst`,
 * `rest`, `mats`, `dans`, `skott`, `kurs`, `kors`, ... Braxen's schwa and
 * secondary-stress notation (`efter` -> `ˈɛftər`, `rykte` -> `rˈʏktˌə`) is kept
 * as-is — that is exactly the kind of difference the NST-vs-Braxen audition
 * preferred.
 *
 * What remains are the cases where neither usage nor Braxen's default reading is
 * right for running text. Entries are canonical **NST SAMPA** and win over both
 * the lexicon and the rules.
 *
 * Keys are lowercase. Values are variants, best first.
 */

export const OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  // Braxen drops the `g` (`n "o: . r ,a` -> /ˈnoːrˌa/); the standard form keeps it.
  "några": ['""no:$gra'],

  // Braxen's preferred row is short /nɔt/; the established spoken form is long.
  "nåt": ['"no:t'],
};
