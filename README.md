# fras

Swedish grapheme-to-phoneme for [Piper](https://github.com/rhasspy/piper), built to
**replace espeak-ng** for Swedish synthesis. It has two layers:

- **specific overrides** — a compact, one-pronunciation-per-word lexicon sourced from
  **Braxen 1.0**, with the NST lexicon (`swe030224NST.pron`) kept as a full-word
  fallback so no word is lost, plus a small curated list for the few readings Braxen
  still gets wrong;
- **generic rules** — Swedish letter-to-sound rules, seeded from espeak-ng's
  `sv_rules`/`sv_list` and iterated against the lexicon.

The canonical internal representation is **NST SAMPA** (accent I/II, syllables,
compounds). Braxen's *Base* transcriptions are converted to it with a table verified
to render byte-identically to the NST-vs-Braxen audition's `braxenVoiceIpa()` (see
*Braxen as the pronunciation source*). The committed lexicon stores one preferred
variant per word. Translation to the alphabet a Piper voice was trained on happens
only at the edge.

## How the lexicon picks a pronunciation

Both resources list several source entries per lowercased headword: inflections,
homographs and proper names. Lowercasing merges them, so file order alone is not safe.

`npm run build:braxen:lexicon` converts every Braxen full-word headword to NST SAMPA
and stores one pronunciation per word, ranking the source rows by:

1. spelled exactly like the lowercased headword (not a capitalized proper name);
2. function words (determiners, conjunctions, pronouns, prepositions, adverbs),
   then nouns, adjectives, verbs, proper names, acronyms, participles;
3. Braxen file order.

`npm run merge:lexicon` then takes every Braxen word and fills the gaps from NST:
every NST headword that is a full word and that Braxen lacks is copied over, so no
dictionary word is lost. The merge **asserts** that every NST full-word headword
resolves in the output. A few high-frequency readings still need a nudge, so they live
in `data/overrides.ts`.

## Why the edge adapter exists

The Swedish Piper voices were trained **before espeak-ng PR #2364**, so they only
cover the older Swedish inventory. fras therefore never emits the newer symbols:

- `r` + `t/d/l/n` is emitted as **two** phonemes (`rt`, `rd`, `rl`, `rn`), not the
  precomposed retroflexes `ʈ ɖ ɭ ɳ`;
- the sje-sound is written `ʃ`, not `ɧ`.

Everything else is calibrated against the voices' own espeak-ng output and
`data/nst-xsampa.sym` (short ö is `œ`, `g` is `ɡ`, `rs` stays `ʂ`, ...). See
`src/to-voice-ipa.ts` and `docs/validation.md`.

## Usage

```ts
import { textToIpa, annotate, phonetizeWord, piperBlocks } from "fras";

textToIpa("Hej på dig!");       // "hˈɛj pˈoː dˈɛj!"  (voice IPA)
annotate("Hej på dig!").text;   // "[[hˈɛj]] [[pˈoː]] [[dˈɛj]]!"  (per-word blocks)
piperBlocks("Kapitel 12, 46 500."); // "[[kapˈɪtɛl tˈɔlv, …]]" (one block, numbers spelled)
phonetizeWord("kärlek");        // { variants: ["s'\"\"E:$l`%e:k"], source: "lexicon" }
```

CLI:

```sh
node src/cli.ts "Hej på dig"          # IPA
node src/cli.ts annotate "Hej på dig" # [[ …IPA… ]] per word
node src/cli.ts piper "Hej 12!"       # one [[ …IPA… ]] block (espeak-free handoff)
node src/cli.ts word kärlek bilen     # per-word detail + provenance
node src/cli.ts lexicon kärlek        # raw NST entry
```

`piperBlocks()` phonetizes the **whole** utterance with fras and returns it as a
single Piper raw-phoneme block, so Piper's embedded espeak-ng never phonetizes
anything. Numbers and common abbreviations are spelled out first
(`normalizeText`) and typographic punctuation is mapped to symbols the voices'
`phoneme_id_map` contains.

## Build, test, evaluate

```sh
npm install
npm run build:lexicon        # swe030224NST.pron -> data/nst-lexicon.jsonl.gz (baseline)
npm run build:braxen:lexicon # fetch Braxen 1.0 -> data/braxen-lexicon.jsonl.gz
npm run merge:lexicon        # Braxen + NST fallback -> data/lexicon.jsonl.gz
npm run prune                # rule coverage over the full lexicon (dry run)
npm run prune:write          # emit pruned lexicon + rule index + coverage report
npm run build:compact        # pack the production lexicon + rule index (runtime format)
npm run frequency            # fetch Flex -> data/flex-frequency.tsv.gz (usage statistics)
npm run frequency:report     # long-tail dropoff stats for the --min-freq cutoff
npm test
npm run typecheck
npm run eval                 # rule-only accuracy against the merged lexicon
npm run audit -- --voice /path/to/sv_SE-alma-medium.onnx
npm run build:braxen         # fetch Braxen 1.0 -> data/braxen.jsonl.gz (audit subset)
npm run audit:nst            # NST vs Braxen phonetic audit -> data/braxen-nst-audit.jsonl.gz
npm run audition             # hear the top NST-vs-Braxen differences (needs voxos)
```

`npm run eval` is the metric that drives the "rules until they cover the lexicon"
goal: it runs the rule-only path and compares it with the lexicon's own transcriptions
(ignoring stress and boundaries). It is also the training/validation set for the
eventual learned/compressed model.

`npm run prune` turns that into a production split. For every merged headword it asks
whether the rules already reproduce the lexicon's phonemes; if so the row no longer
needs to be stored and the rules generalize instead. Rows whose phonemes match but
whose syllable/stress/compound layout does not get a tiny correction that restores the
lexicon's structure (no phonemes stored). `prune:write` emits:

- `data/lexicon.pruned.jsonl.gz` — the **production** lexicon (only rows rules
  cannot reproduce);
- `data/rules.jsonl.gz` — the **rule index**: words the rules cover and which are
  therefore routed straight to the rules (skipping morphology), with an optional
  structure correction;
- `data/lexicon.pruned.compact.gz` / `data/rules.compact.gz` — the packed binary
  runtime form of the two above (`src/compact.ts`, `npm run build:compact`).
  `lexicon()` / `ruleIndex()` prefer these: a lookup is a binary search over
  byte-sorted keys and the data loads into a handful of typed arrays instead of one
  `Map` object per row, which is what keeps the process small on weak hardware;
- `data/rule-coverage.jsonl.gz` — per-word classification/divergence, the input for
  automating rule search.

Routing matters: without it the morphology fallback would split almost any removed
row and produce a different pronunciation. The rule index makes rule-covered words
take the rule path deterministically, so they are independent of every other prune.

`prune:write` re-verifies the written artifacts against the merged lexicon end to end
(`--check` does the same on demand). The merged `data/lexicon.jsonl.gz` stays
committed as the comparison baseline, so rule changes are always re-scored against it;
`data/nst-lexicon.jsonl.gz` is kept as the frozen NST fallback/regression reference.

### Usage-based pruning

Rule coverage says whether a row *can* be replaced; frequency says whether it is
worth keeping at all. `npm run frequency` downloads Språkbanken's **Flex** frequency
lexicon (CC-BY-4.0), sums the novel/newspaper/forum per-million rates, and commits a
compact table (`data/flex-frequency.tsv.gz`) restricted to merged-lexicon headwords.
`npm run frequency:report` prints the dropoff — rows surviving each threshold and the
Swedish token coverage they carry — which is how the cutoff was chosen.

The committed policy is `--min-freq 0.03 --full-words-only`:

| layer | rows | share of all Flex tokens |
| --- | --- | --- |
| rule index (rules reproduce them) | 216,683 | ~43.2% |
| production lexicon (stored) | 253,340 | ~48.4% |
| dropped long tail | 709,580 | ~0.06% |

Dropping the long tail takes the stored list from 970k to 253k rows (~8 MB → 2.4 MB gz)
and loses 1,730 of ~2.99M per-million tokens the stored rows used to provide — 0.06% of
all tokens, 0.11% of the stored rows' coverage. The distribution is a textbook Zipf
tail: 523k candidate rows never appear in Flex at all, and the curve flattens sharply
after ~50k rows. `--full-words-only` additionally drops rows the tokenizer can never
reach (hyphenated, underscore-joined, affix and abbreviation entries), independent of
frequency.

Rule coverage is lower than it was against NST (~19% vs 29%): the rules were iterated
against NST, and Braxen's transcriptions differ (schwa `@`, `ae`/`oe` vowels, more
compound structure), so fewer rows are reproduced by the rules and more must be stored.
That is the intended trade — the stored rows are the better Braxen pronunciations.

The rule set was re-scored against Braxen and reworked (`src/rules/sv-rules.ts`): the
rules whose output was already produced by decomposing them (the `$`-only ending rules,
the monosyllable rules, `n` before `[kg]`) were removed, and a rule was added for the
reduced vowel of a final `-eC` ending (`boken` → `b"u:$k@n`, `systemet` → `…m@t`),
which Braxen writes as schwa and the rules previously could not emit at all.

Words dropped this way fall through to morphology → generic rules and may diverge
from the lexicon; that is acceptable precisely because they are rare.
`verifyProduction()` therefore only requires **rule-index** words to reproduce the
lexicon.

### Braxen as the pronunciation source

The lexicon is Braxen-first. `npm run build:braxen:lexicon` converts Braxen's *Base*
transcriptions to NST SAMPA with `braxenToNstSampa()` (`src/braxen.ts`) and **asserts**
the invariant

```
toVoiceIpa(braxenToNstSampa(base)) === braxenVoiceIpa(base)
```

for every row — the runtime therefore reproduces the exact rendering that won the
NST-vs-Braxen audition. `npm run merge:lexicon` then adds the NST fallback for the
Braxen-missing full-word headwords and asserts none is lost. NST's own transcriptions
are kept in `data/nst-lexicon.jsonl.gz` for comparison only.

### NST vs Braxen audit

`npm run audit:nst` is an advisory, historical cross-check of the NST transcriptions
against **Braxen 1.0** (see *Data & attribution*), independent of the rule layer. Both
resources are normalized to a shared standard IPA *and* to the voice alphabet fras
hands to Piper (`SV_VOICE_MAP`); Braxen is converted the same way, with foreign
phonemes collapsed onto the nearest symbol the voice can speak. Segment sequences
are compared ignoring stress, syllables, compounds, morphemes and word boundaries,
best-of-variants. Each shared headword is classified as

- `match` — identical IPA;
- `inventory` — different IPA, but both collapse to the same Piper input (retroflex
  and sje notation, the four e-sounds, ...): Piper would not render a difference;
- `real` — the Piper input, and therefore the output, would differ.

The summary (counts, top substitution pairs, examples) goes to stdout, and the
per-word mismatches are also written to `data/braxen-nst-audit.jsonl.gz` (+ a
`.meta.json`). This is **advisory only** and has no effect on the runtime pipeline.
`npm run build:braxen` downloads Braxen and emits `data/braxen.jsonl.gz`, the
compact NST-overlap subset the audit reads.

`npm run audition` turns that audit into a listening test: it picks clean examples
of the top divergence buckets (the target substitution is the *only* difference),
biased toward common words via the Flex frequency table, and plays the NST
rendering first and the Braxen rendering second through [voxos](../voxos)'s
one-shot `say --raw` (Piper). You pick first/second/replay/same and it prints and
logs (`data/audition-log.jsonl`) a per-bucket preference tally — which resource's
transcriptions actually voice well with the current voice. Also advisory.

## Pipeline

```
text ─▶ tokenize
        ├─ override table            (highest priority)
        ├─ lexicon                   (Braxen-first, one preferred variant; pruned)
        ├─ rule index                (rule-covered -> rules, skip morphology)
        ├─ morphology                (compound split, suffix stripping)
        └─ generic rules             (grapheme -> NST SAMPA)
     ─▶ NST SAMPA (canonical)
     ─▶ toVoiceIpa()  ─▶ `[[ … ]]` blocks  and/or  raw phoneme array

`piperBlocks()` is the espeak-free path: it spells out numbers, phonetizes every
word and returns the whole utterance as one `[[ …IPA… ]]` block.
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/sampa.ts` | NST SAMPA model: symbols, tokenizer, syllables |
| `src/to-voice-ipa.ts` | NST SAMPA -> voice IPA adapter + profile |
| `src/lexicon.ts` | loads full/pruned lexicon + rule index |
| `src/frequency.ts` | Flex frequency table + usage-prune policy |
| `src/morphology.ts` | compound/suffix fallback |
| `src/rules/` | rule engine + Swedish rules |
| `src/phonetize.ts` | the pipeline + public API |
| `src/annotate.ts` | `[[ …IPA… ]]` output for Piper (per word) |
| `src/normalize.ts` | numbers/abbreviations -> words (`spellNumber`, `normalizeText`) |
| `src/piper.ts` | espeak-free Piper handoff (`piperPhonemes`, `piperBlocks`, `preload`) |
| `data/overrides.ts` | curated word overrides |
| `src/braxen.ts` | Braxen Base ↔ IPA/NST tables + segment comparison + audit |
| `tools/build-lexicon.ts` | build the NST baseline lexicon (`data/nst-lexicon.jsonl.gz`) |
| `tools/build-braxen-lexicon.ts` | Braxen → NST SAMPA lexicon (asserts voice equivalence) |
| `tools/merge-lexicon.ts` | merge Braxen + NST fallback (asserts no word lost) |
| `tools/build-frequency.ts` | fetch Flex → compact frequency table |
| `tools/build-braxen.ts` | fetch Braxen → compact NST-overlap subset (audit) |
| `tools/frequency-report.ts` | long-tail dropoff statistics |
| `tools/prune-lexicon.ts` | rule-coverage audit + production prune (rules + frequency) |
| `tools/eval.ts` | rule-only accuracy harness |
| `tools/audit-nst.ts` | NST vs Braxen phonetic audit (advisory) |
| `tools/audition.ts` | interactive NST-vs-Braxen listening test (advisory) |
| `tools/audit-voice.ts` | check emitted symbols against a voice |

## Status

v2: Braxen-first lexicon + NST fallback + adapter + rules + morphology + eval + prune.
The rule layer is a **headstart**: it reproduces the lexicon's phonemes for ~18% of the
merged headwords today, and all of that is pruned from the production lexicon and routed
to the rules (0.3% match the full string; 17.5% need a small structure correction). The
remaining ~82% is mostly stress, schwa and loanword vowel length in the rules — the
intended target for a learned model behind the same `G2P` seam.

The production lexicon is additionally cut to the common core by usage
(`--min-freq 0.03 --full-words-only`): 970k stored rows → 263k, keeping ~99.89% of
the token coverage those rows provided. See *Usage-based pruning* above.

## Data & attribution

- Braxen 1.0 — Swedish Agency for Accessible Media (MTM) & Språkbanken,
  [Apache-2.0](https://github.com/sprakbankental/braxen); the **primary pronunciation
  source** (`data/braxen-lexicon.jsonl.gz`), also used for the advisory phonetic audit
  (`data/braxen.jsonl.gz`, `data/braxen-nst-audit.jsonl.gz`). Please cite Tånnander &
  Edlund (2025), *Braxen 1.0*, NoDaLiDa/Baltic-HLT.
- NST Swedish pronunciation lexicon (`swe030224NST.pron`) — full-word **fallback** for
  headwords Braxen lacks (`data/nst-lexicon.jsonl.gz`).
- Flex frequency lexicon — Språkbanken, [CC-BY-4.0](https://sprakbanken.se/resurser/flex)
  (usage statistics for the frequency prune; `data/flex-frequency.tsv.gz`).
- `nst-xsampa.sym` — Wikispeech, CC0.
- espeak-ng `dictsource/sv_rules`, `sv_list` — GPL-3.0 (used as a reference for the
  rule layer only; no code is copied).
