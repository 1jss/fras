# Fras internals

This is the developer/long-form companion to the [README](../README.md). It
covers how the lexicon is built and pruned, how the rule layer works, and how to
maintain the committed resources. You don't need any of it to *use* Fras.

## The pipeline

```
text ─▶ tokenize
        ├─ override table            (highest priority)
        ├─ lexicon                   (Braxen-first, one preferred variant; pruned)
        ├─ rule index                (rule-covered -> rules, skip morphology)
        ├─ morphology                (compound split, suffix stripping)
        └─ generic rules             (grapheme -> NST SAMPA)
     ─▶ NST SAMPA (canonical)
     ─▶ toVoiceIpa()  ─▶ `[[ … ]]` blocks  and/or  raw phoneme array
```

`piperBlocks()` is the full-utterance path: it spells out numbers, phonetizes
every word with Fras and returns the whole utterance as one `[[ …IPA… ]]` block.

The canonical internal representation is **NST SAMPA** (accent I/II, syllables,
compounds). Braxen's *Base* transcriptions are converted to it with a table
verified to render byte-identically to `braxenVoiceIpa()`. The committed lexicon
stores one preferred variant per word; translation to the alphabet a Piper voice
was trained on happens only at the edge (`src/to-voice-ipa.ts`).

## How the lexicon picks a pronunciation

Both resources list several source entries per lowercased headword: inflections,
homographs and proper names. Lowercasing merges them, so file order alone is not
safe.

`npm run build:braxen:lexicon` converts every Braxen full-word headword to NST
SAMPA and stores one pronunciation per word, ranking the source rows by:

1. spelled exactly like the lowercased headword (not a capitalized proper name);
2. **usage** — the POS-conditioned frequency table (`data/pos-frequency.tsv.gz`):
   the row whose MSD tag is most frequent in running text wins. That resolves the
   homographs the old POS order got wrong — `kan` is the verb /kan/ (can), not the
   rare noun /kɑːn/ (khan), and `var`, `drog`, `bor`, `läst` take their verb
   reading. Exact-tag matches are preferred, so a row of a *different* form that
   merely shares the POS cannot win;
3. function words (determiners, conjunctions, pronouns, prepositions, adverbs),
   then nouns, adjectives, verbs, proper names, acronyms, participles;
4. Braxen file order.

`npm run merge:lexicon` then takes every Braxen word and fills the gaps from the
frozen NST baseline: every NST headword that is a full word and that Braxen lacks
is copied over, so no dictionary word is lost. The merge **asserts** that every
NST full-word headword resolves in the output. A few readings the frequency table
cannot settle still need a nudge, so they live in `data/overrides.ts`.

### Braxen as the pronunciation source

The lexicon is Braxen-first. `npm run build:braxen:lexicon` converts Braxen's
*Base* transcriptions to NST SAMPA with `braxenToNstSampa()` (`src/braxen.ts`) and
**asserts** the invariant

```
toVoiceIpa(braxenToNstSampa(base)) === braxenVoiceIpa(base)
```

for every row, so the runtime reproduces the Braxen rendering that was chosen for
the voice exactly. `npm run merge:lexicon` then adds the frozen NST fallback
for the Braxen-missing full-word headwords and asserts none is lost.

## Usage-based pruning

Rule coverage says whether a row *can* be replaced; frequency says whether it is
worth keeping at all — and, before that, which reading a homograph gets.

`npm run frequency` downloads Språkbanken's **Corpus word statistics**
(CC-BY-4.0), streams the 5.5 GB word/POS/frequency list without unpacking it to
disk, stops at the cutoff and commits a compact table
(`data/pos-frequency.tsv.gz`) of `(word, MSD tag)` per-million rates restricted to
Braxen ∪ NST headwords. The same table supplies `build:braxen:lexicon`'s reading
selection. `node tools/frequency-report.ts` prints the long-tail dropoff that
informs the cutoff.

The committed policy is `--min-freq 0.01 --full-words-only`:

| layer | rows | share of all tokens |
| --- | --- | --- |
| rule index (rules reproduce them) | 216,691 | ~38% |
| production lexicon (stored) | 198,392 | ~40% |
| dropped long tail | 764,520 | remainder (< 0.01/M each) |

The full merged lexicon is 1,179,603 headwords. `--full-words-only` additionally
drops rows the tokenizer can never reach (hyphenated, underscore-joined, affix and
abbreviation entries), independent of frequency.

Rule coverage is lower than it was against NST (~19% vs 29%): the rules were
iterated against NST, and Braxen's transcriptions differ (schwa `@`, `ae`/`oe`
vowels, more compound structure), so fewer rows are reproduced by the rules and
more must be stored. That is the intended trade — the stored rows are the better
Braxen pronunciations.

Words dropped this way fall through to morphology → generic rules and may diverge
from the lexicon; that is acceptable precisely because they are rare.
`verifyProduction()` therefore only requires **rule-index** words to reproduce the
lexicon.

## The rule layer and pruning

`node tools/prune-lexicon.ts` (dry run) asks, for every merged headword, whether
the rules already reproduce the lexicon's phonemes; if so the row no longer needs
to be stored and the rules generalize instead. Rows whose phonemes match but whose
syllable/stress/compound layout does not get a tiny correction that restores the
lexicon's structure (no phonemes stored). `npm run prune:write` emits:

- `data/lexicon.pruned.jsonl.gz` — the **production** lexicon (only rows rules
  cannot reproduce);
- `data/rules.jsonl.gz` — the **rule index**: words the rules cover and which are
  therefore routed straight to the rules (skipping morphology), with an optional
  structure correction;
- `data/lexicon.pruned.compact.gz` / `data/rules.compact.gz` — the packed binary
  runtime form of the two above (`src/compact.ts`). `lexicon()` / `ruleIndex()`
  prefer these: a lookup is a binary search over byte-sorted keys and the data
  loads into a handful of typed arrays instead of one `Map` object per row, which
  is what keeps the process small on weak hardware;
- `data/rule-coverage.jsonl.gz` — per-word classification/divergence, the input for
  automating rule search.

Routing matters: without it the morphology fallback would split almost any removed
row and produce a different pronunciation. The rule index makes rule-covered words
take the rule path deterministically, so they are independent of every other prune.

`prune:write` re-verifies the written artifacts against the merged lexicon end to
end. The merged `data/lexicon.jsonl.gz` stays committed as the comparison
baseline, so rule changes are always re-scored against it; `data/nst-lexicon.jsonl.gz`
is the frozen NST fallback/regression reference.

## Rebuilding the dictionary

```sh
npm install
npm run setup
```

`npm run setup` runs, in order:

1. `frequency` — download the corpus statistics → `data/pos-frequency.tsv.gz`;
2. `build:braxen:lexicon` — Braxen → `data/braxen-lexicon.jsonl.gz`;
3. `merge:lexicon` — Braxen-first + NST fallback → `data/lexicon.jsonl.gz`;
4. `prune:write` — production lexicon + rule index + compact artifacts, then
   self-verifies.

Steps whose outputs already exist are skipped; pass `--force` to rebuild anyway,
`--skip-frequency` to keep the existing table, or `--from <step>` to resume. Each
step is also runnable directly (`node tools/<tool>.ts`).

The NST baseline (`data/nst-lexicon.jsonl.gz`) is a **frozen committed input** and
is never rebuilt from `swe030224NST.pron`; the raw file is not needed.

## Maintenance checks

- `node tools/prune-lexicon.ts` — rule-coverage over the merged lexicon (dry run).
- `node tools/frequency-report.ts` — long-tail dropoff for choosing `--min-freq`.
- `node tools/audit-voice.ts --voice /path/to/sv_SE-alma-medium.onnx` — confirm
  every symbol the active profile can emit exists in a voice's `phoneme_id_map`,
  so nothing is silently dropped at synthesis time. Presence is necessary but not
  sufficient — a symbol can be present yet untrained — so `src/to-voice-ipa.ts`
  emits only the inventory the voices were trained on.

## Layout

| Path | Purpose |
| --- | --- |
| `src/sampa.ts` | NST SAMPA model: symbols, tokenizer, syllables |
| `src/to-voice-ipa.ts` | NST SAMPA -> voice IPA adapter + profile |
| `src/lexicon.ts` | loads full/pruned lexicon + rule index |
| `src/frequency.ts` | word-frequency interface + usage-prune policy |
| `src/pos-frequency.ts` | POS-conditioned frequency table (reading selection + prune) |
| `src/morphology.ts` | compound/suffix fallback |
| `src/rules/` | rule engine + Swedish rules |
| `src/phonetize.ts` | the pipeline + public API |
| `src/annotate.ts` | `[[ …IPA… ]]` output for Piper (per word) |
| `src/normalize.ts` | numbers/abbreviations -> words (`spellNumber`, `normalizeText`) |
| `src/piper.ts` | Piper handoff (`piperPhonemes`, `piperBlocks`, `preload`) |
| `src/braxen.ts` | Braxen Base ↔ NST SAMPA conversion tables |
| `data/overrides.ts` | curated word overrides |
| `tools/setup.ts` | one-command rebuild of all committed resources |
| `tools/build-braxen-lexicon.ts` | Braxen → NST SAMPA lexicon (asserts voice equivalence) |
| `tools/merge-lexicon.ts` | merge Braxen + NST fallback (asserts no word lost) |
| `tools/build-pos-frequency.ts` | Corpus word statistics → compact POS frequency table |
| `tools/frequency-report.ts` | long-tail dropoff statistics |
| `tools/prune-lexicon.ts` | rule-coverage audit + production prune |
| `tools/audit-voice.ts` | check emitted symbols against a voice |

## Status

The rule layer is a **headstart**: it reproduces the lexicon's phonemes for ~18%
of the merged headwords today (0.3% match the full string; 18.1% need a small
structure correction), and all of that is pruned from the production lexicon and
routed to the rules. The remaining ~82% is mostly stress, schwa and loanword vowel
length in the rules.

The production lexicon is additionally cut to the common core by usage
(`--min-freq 0.01 --full-words-only`): 962,912 storage candidates → 198,392
stored, the rest falling through to morphology and the generic rules. The **same
table decides each homograph's reading**, so `kan` scores the verb.

## Data & attribution

- Braxen 1.0 — Swedish Agency for Accessible Media (MTM) & Språkbanken,
  [Apache-2.0](https://github.com/sprakbankental/braxen); the **primary
  pronunciation source** (`data/braxen-lexicon.jsonl.gz`). Please cite Tånnander &
  Edlund (2025), *Braxen 1.0*, NoDaLiDa/Baltic-HLT.
- NST Swedish pronunciation lexicon (`swe030224NST.pron`) — full-word **fallback**
  for headwords Braxen lacks (`data/nst-lexicon.jsonl.gz`).
- Corpus word statistics — Språkbanken,
  [CC-BY-4.0](https://sprakbanken.se/en/resources/ordstatistik) (word/POS
  per-million frequencies for reading selection and the frequency prune;
  `data/pos-frequency.tsv.gz`).
- espeak-ng `dictsource/sv_rules`, `sv_list` — GPL-3.0 (used as a reference for the
  rule layer only; no code is copied).
