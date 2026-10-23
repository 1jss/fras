# Fras

## What

Fras converts Swedish text to Swedish phonemes in the alphabet Piper's Swedish
voices were trained on. It uses a pronunciation lexicon (Braxen 1.0 with an NST
fallback) plus Swedish letter-to-sound rules, and emits either IPA or a raw
phoneme block for Piper.

## Why

An update to espeak-ng's phonetics broke some existing voices in Piper. The
Swedish voice models were trained on an older phoneme inventory, and the newer
phonetics emit symbols those models were not trained on, so the voices lost
certain sounds. Fras emits the inventory the voices were actually trained on, so
every symbol it produces is one the voice can speak.

## How

### Install

```sh
npm install
```

The lexicon and rules are committed under `data/`, so there is no build step to
use Fras. Run `npm run build` only if you import it as a library from another
project (it emits `dist/`).

### Run — CLI

```sh
node src/cli.ts "Hej på dig"          # IPA
node src/cli.ts annotate "Hej på dig" # [[ …IPA… ]] per word
node src/cli.ts piper "Hej 12!"       # one [[ …IPA… ]] block (pre-phonetized for Piper)
node src/cli.ts word kärlek bilen     # per-word detail + provenance
node src/cli.ts lexicon kärlek        # raw lexicon entry
```

### Run — code

```ts
import { textToIpa, annotate, phonetizeWord, piperBlocks } from "fras";

textToIpa("Hej på dig!");       // "hˈɛj pˈoː dˈɛj!"  (voice IPA)
annotate("Hej på dig!").text;   // "[[hˈɛj]] [[pˈoː]] [[dˈɛj]]!"  (per-word blocks)
piperBlocks("Kapitel 12, 46 500."); // "[[kapˈɪtɛl tˈɔlv, …]]" (one block, numbers spelled)
phonetizeWord("kärlek");        // { variants: ["s'\"\"E:$l`%e:k"], source: "lexicon" }
```

`piperBlocks()` phonetizes the **whole** utterance and returns it as one Piper
raw-phoneme block, so the pronunciation is entirely Fras's.

### How it works

```
text ─▶ tokenize
        ├─ overrides        (curated corrections)
        ├─ lexicon          (Braxen-first, one preferred reading; pruned)
        ├─ rule index       (rules reproduce it -> skip morphology)
        ├─ morphology       (compound split, suffix stripping)
        └─ Swedish rules    (grapheme -> NST SAMPA)
     ─▶ canonical NST SAMPA ─▶ toVoiceIpa() ─▶ `[[ … ]]` for Piper
```

The lexicon stores canonical NST SAMPA; translation to the voice alphabet happens
only at the edge. See [docs/development.md](docs/development.md) for how the
lexicon is built and pruned.

## Data & attribution

- Braxen 1.0 — Swedish Agency for Accessible Media (MTM) & Språkbanken,
  [Apache-2.0](https://github.com/sprakbankental/braxen); the primary
  pronunciation source. Please cite Tånnander & Edlund (2025), *Braxen 1.0*,
  NoDaLiDa/Baltic-HLT.
- NST Swedish pronunciation lexicon (`swe030224NST.pron`) — full-word fallback for
  headwords Braxen lacks.
- Corpus word statistics — Språkbanken,
  [CC-BY-4.0](https://sprakbanken.se/en/resources/ordstatistik) (reading selection
  and the frequency prune).
- espeak-ng `dictsource/sv_rules`, `sv_list` — GPL-3.0 (reference for the rule
  layer only; no code is copied).

## Rebuilding the dictionary (optional)

You do **not** need this to use Fras — the resources are committed. If you want to
regenerate them from the upstream sources:

```sh
npm install
npm run setup
```

This converts Braxen to the NST SAMPA lexicon, merges in the frozen NST fallback,
and prunes to the production lexicon + rule index, then verifies the result. The
NST baseline is a frozen input and is never rebuilt. See
[docs/development.md](docs/development.md) for the individual steps, the prune
policy, and maintenance checks.

## Svenska

Fras omvandlar svensk text till svenska fonem i det alfabet som Pipers svenska
röster tränades på. En uppdatering av espeak-ng:s fonetik gjorde att vissa
befintliga röster i Piper tappade vissa ljud; Fras skickar i stället de fonem
rösterna faktiskt tränades på. Uttalet kommer från en ordbok (Braxen 1.0 med NST
som reserv) och svenska uttalsregler, och kan ges som IPA eller som fonemblock
till Piper.

## Tags

`swedish` `svenska` `text-to-speech` `talsyntes` `tts` `g2p`
`grafem-till-fonem` `phonemes` `fonem` `pronunciation` `uttal` `ipa` `piper`
`espeak-ng` `lexicon` `ordbok` `braxen` `nst`
