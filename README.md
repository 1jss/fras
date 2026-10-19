# fras

Swedish grapheme-to-phoneme for [Piper](https://github.com/rhasspy/piper), built to
**replace espeak-ng** for Swedish synthesis. It has two layers:

- **specific overrides** — the full NST pronunciation lexicon
  (`swe030224NST.pron`, 927k lines) plus a small curated list for common words NST
  omits;
- **generic rules** — Swedish letter-to-sound rules, seeded from espeak-ng's
  `sv_rules`/`sv_list` and iterated against NST.

The canonical internal representation is **NST SAMPA** (lossless: accent I/II, all
variants, syllables, compounds). Translation to the alphabet a Piper voice was
trained on happens only at the edge.

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

textToIpa("Hej på dig!");       // "ˈhɛj ˈpoː ˈdɛj!"  (voice IPA)
annotate("Hej på dig!").text;   // "[[ˈhɛj]] [[ˈpoː]] [[ˈdɛj]]!"  (per-word blocks)
piperBlocks("Kapitel 12, 46 500."); // "[[kaˈpɪtɛl ˈtɔlv, …]]" (one block, numbers spelled)
phonetizeWord("kärlek");        // { variants: ['""s\'E:$%l`e:k'], source: "lexicon" }
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
npm run build:lexicon   # swe030224NST.pron -> data/nst-lexicon.jsonl.gz (~7 MB)
npm run prune           # rule coverage over the full lexicon (dry run)
npm run prune:write     # emit pruned lexicon + rule index + coverage report
npm run frequency       # fetch Flex -> data/flex-frequency.tsv.gz (usage statistics)
npm run frequency:report # long-tail dropoff stats for the --min-freq cutoff
npm test
npm run typecheck
npm run eval            # rule-only accuracy against NST
npm run audit -- --voice /path/to/sv_SE-alma-medium.onnx
```

`npm run eval` is the metric that drives the "rules until they cover NST" goal: it
runs the rule-only path and compares it with NST's own transcriptions (ignoring
stress and boundaries). It is also the training/validation set for the eventual
learned/compressed model.

`npm run prune` turns that into a production split. For every NST headword it asks
whether the rules already reproduce NST's phonemes; if so the row no longer needs to
be stored and the rules generalize instead. Rows whose phonemes match but whose
syllable/stress/compound layout does not get a tiny correction that restores NST's
structure (no phonemes stored). `prune:write` emits:

- `data/nst-lexicon.pruned.jsonl.gz` — the **production** lexicon (only rows rules
  cannot reproduce), loaded by `lexicon()`;
- `data/nst-rules.jsonl.gz` — the **rule index**: words the rules cover and which are
  therefore routed straight to the rules (skipping morphology), with an optional
  structure correction;
- `data/rule-coverage.jsonl.gz` — per-word classification/divergence, the input for
  automating rule search.

Routing matters: without it the morphology fallback would split almost any removed
row and produce a different pronunciation. The rule index makes rule-covered words
take the rule path deterministically, so they are independent of every other prune.

`prune:write` re-verifies the written artifacts against NST end to end (`--check`
does the same on demand). The full `data/nst-lexicon.jsonl.gz` stays committed as the
comparison baseline, so rule changes are always re-scored against it.

### Usage-based pruning

Rule coverage says whether a row *can* be replaced; frequency says whether it is
worth keeping at all. `npm run frequency` downloads Språkbanken's **Flex** frequency
lexicon (CC-BY-4.0), sums the novel/newspaper/forum per-million rates, and commits a
compact table (`data/flex-frequency.tsv.gz`) restricted to NST headwords.
`npm run frequency:report` prints the dropoff — rows surviving each threshold and the
Swedish token coverage they carry — which is how the cutoff was chosen.

The committed policy is `--min-freq 0.01 --full-words-only`:

| layer | rows | share of all Flex tokens |
| --- | --- | --- |
| rule index (rules reproduce them) | 234,454 | ~56.6% |
| production lexicon (stored) | 199,031 | ~23.87% |
| dropped long tail | 385,464 | ~0.009% |

Dropping the long tail takes the stored list from 584k to 199k rows (5.1 MB → 2.1 MB
gz) and loses 282 of ~713k per-million tokens the stored rows used to provide — 0.04%
of their coverage. The distribution is a textbook Zipf tail: 318k candidate rows never
appear in Flex at all, and the elbow sits around 20k–35k rows (≈ `>= 1` per million).
`--full-words-only` additionally drops rows the tokenizer can never reach (hyphenated,
underscore-joined, affix and abbreviation entries), independent of frequency.

Words dropped this way fall through to morphology → generic rules and may diverge
from NST; that is acceptable precisely because they are rare. `verifyProduction()`
therefore only requires **rule-index** words to reproduce NST.

## Pipeline

```
text ─▶ tokenize
        ├─ override table            (highest priority)
        ├─ NST lexicon               (pruned; full kept as baseline)
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
| `tools/build-lexicon.ts` | build the full compact lexicon |
| `tools/build-frequency.ts` | fetch Flex → compact frequency table |
| `tools/frequency-report.ts` | long-tail dropoff statistics |
| `tools/prune-lexicon.ts` | rule-coverage audit + production prune (rules + frequency) |
| `tools/eval.ts` | NST accuracy harness |
| `tools/audit-voice.ts` | check emitted symbols against a voice |

## Status

v1: lexicon + adapter + rules + morphology + eval + prune. The rule layer is a
**headstart**: it reproduces NST's phonemes for ~29% of the lexicon today, and all of
that is now pruned from the production lexicon and routed to the rules (2% match the
full string; 26% need a small structure correction). The remaining ~71% is mostly
stress and loanword vowel length in the rules — the intended target for a learned
model behind the same `G2P` seam.

The production lexicon is additionally cut to the common core by usage
(`--min-freq 0.01 --full-words-only`): 584k stored rows → 199k, keeping ~99.96% of
the token coverage those rows provided. See *Usage-based pruning* above.

## Data & attribution

- NST Swedish pronunciation lexicon (`swe030224NST.pron`).
- Flex frequency lexicon — Språkbanken, [CC-BY-4.0](https://sprakbanken.se/resurser/flex)
  (usage statistics for the frequency prune; `data/flex-frequency.tsv.gz`).
- `nst-xsampa.sym` — Wikispeech, CC0.
- espeak-ng `dictsource/sv_rules`, `sv_list` — GPL-3.0 (used as a reference for the
  rule layer only; no code is copied).
