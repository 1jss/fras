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
import { textToIpa, annotate, phonetizeWord } from "fras";

textToIpa("Hej på dig!");       // "ˈhɛj ˈpoː ˈdɛj!"  (voice IPA)
annotate("Hej på dig!").text;   // "[[ˈhɛj]] [[ˈpoː]] [[ˈdɛj]]!"  (Piper blocks)
phonetizeWord("kärlek");        // { variants: ['""s\'E:$%l`e:k'], source: "lexicon" }
```

CLI:

```sh
node src/cli.ts "Hej på dig"          # IPA
node src/cli.ts annotate "Hej på dig" # [[ …IPA… ]] for Piper
node src/cli.ts word kärlek bilen     # per-word detail + provenance
node src/cli.ts lexicon kärlek        # raw NST entry
```

## Build, test, evaluate

```sh
npm install
npm run build:lexicon   # swe030224NST.pron -> data/nst-lexicon.jsonl.gz (~7 MB)
npm test
npm run typecheck
npm run eval            # rule-only accuracy against NST
npm run audit -- --voice /path/to/sv_SE-alma-medium.onnx
```

`npm run eval` is the metric that drives the "rules until they cover NST" goal: it
runs the rule-only path and compares it with NST's own transcriptions (ignoring
stress and boundaries). It is also the training/validation set for the eventual
learned/compressed model.

## Pipeline

```
text ─▶ tokenize
        ├─ override table            (highest priority)
        ├─ NST lexicon               (all variants preserved)
        ├─ morphology                (compound split, suffix stripping)
        └─ generic rules             (grapheme -> NST SAMPA)
     ─▶ stress assignment
     ─▶ NST SAMPA (canonical)
     ─▶ toVoiceIpa()  ─▶ `[[ … ]]` blocks  and/or  raw phoneme array
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/sampa.ts` | NST SAMPA model: symbols, tokenizer, syllables |
| `src/to-voice-ipa.ts` | NST SAMPA -> voice IPA adapter + profile |
| `src/lexicon.ts` | loads `data/nst-lexicon.jsonl.gz` |
| `src/morphology.ts` | compound/suffix fallback |
| `src/rules/` | rule engine + Swedish rules |
| `src/phonetize.ts` | the pipeline + public API |
| `src/annotate.ts` | `[[ …IPA… ]]` output for Piper |
| `data/overrides.ts` | curated word overrides |
| `tools/build-lexicon.ts` | build the compact lexicon |
| `tools/eval.ts` | NST accuracy harness |
| `tools/audit-voice.ts` | check emitted symbols against a voice |

## Status

v1: lexicon + adapter + rules + morphology + eval. The rule layer is a **headstart**
(currently ~20% exact on a 20k-word NST sample); the remaining error is mostly
stress and loanword vowel length, which is the intended target for a learned model
behind the same `G2P` seam.

## Data & attribution

- NST Swedish pronunciation lexicon (`swe030224NST.pron`).
- `nst-xsampa.sym` — Wikispeech, CC0.
- espeak-ng `dictsource/sv_rules`, `sv_list` — GPL-3.0 (used as a reference for the
  rule layer only; no code is copied).
