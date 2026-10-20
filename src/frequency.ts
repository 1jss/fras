/**
 * Word-frequency interface and usage-prune policy.
 *
 * The per-word rate used for pruning now comes from the POS-conditioned table
 * (`src/pos-frequency.ts`, built by `tools/build-pos-frequency.ts` from
 * Språkbanken's *Corpus word statistics*); `tools/frequency-report.ts` prints the
 * dropoff distribution and `tools/prune-lexicon.ts` uses it to cut the long tail.
 * The plain `word<TAB>frequency` (de)serializer and the `FrequencyTable` seam are
 * kept generic — anything that can answer `frequency(word)` satisfies it. Nothing
 * here is needed at phonetization time.
 */

import { gunzipSync, gzipSync } from "node:zlib";

export interface FrequencyTable {
  /** Usage frequency (per million); 0 when absent. */
  frequency(word: string): number;
  /** Words in the table. */
  readonly size: number;
  /** Sum of the table's frequencies (token mass of the retained words). */
  readonly mass: number;
  /** Raw entries, for reporting. */
  entries(): IterableIterator<[string, number]>;
}

export interface FrequencyMeta {
  source: string;
  url: string;
  license: string;
  fetchedAt: string;
  /** Last-Modified of the upstream source, when the server sent one. */
  sourceModified?: string;
  /** Token mass of the entire source, before intersecting with the lexicon. */
  totalMass: number;
  /** Rows written to the table. */
  rows: number;
  /** Lexicon the table was intersected with. */
  lexicon: string;
}

class MapFrequency implements FrequencyTable {
  readonly #map: Map<string, number>;
  readonly mass: number;

  constructor(map: Map<string, number>) {
    this.#map = map;
    let mass = 0;
    for (const v of map.values()) mass += v;
    this.mass = mass;
  }

  frequency(word: string): number {
    return this.#map.get(word.toLowerCase()) ?? 0;
  }

  get size(): number {
    return this.#map.size;
  }

  entries(): IterableIterator<[string, number]> {
    return this.#map.entries();
  }
}

/** Parse a gzipped `word<TAB>frequency` table. */
export function parseFrequency(gz: Buffer): FrequencyTable {
  const text = gunzipSync(gz).toString("utf8");
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const word = line.slice(0, tab);
    const value = Number(line.slice(tab + 1));
    if (!word || !Number.isFinite(value)) continue;
    map.set(word, value);
  }
  return new MapFrequency(map);
}

/** Six significant digits keep the committed table small without loss of meaning. */
export function formatFrequency(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Serialize entries as a gzipped `word<TAB>frequency` table, sorted by word. */
export function serializeFrequency(
  entries: Iterable<[string, number]>,
  level = 9,
): Buffer {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const raw = sorted.map(([w, v]) => `${w}\t${formatFrequency(v)}\n`).join("");
  return gzipSync(Buffer.from(raw, "utf8"), { level });
}

/**
 * A "full word": a string the tokenizer emits as a single word token.
 *
 * `src/tokenize.ts` splits on every non-letter, so hyphenated, underscore-joined,
 * affix (`x-`, `-x`) and digit-bearing entries can never be reached from text.
 * Unlike `voxos/tools/build-phonetics.py: eligible()`, this accepts any Unicode
 * letter, so accented loanwords (`abbé`, `filé`) — which the tokenizer *does*
 * reach — are kept.
 */
const FULL_WORD_RE = /^[\p{L}\p{M}]+$/u;

export function isFullWord(word: string): boolean {
  return FULL_WORD_RE.test(word);
}

export interface PrunePolicy {
  /** Drop stored rows below this usage frequency (per million); 0 disables. */
  minFreq: number;
  /** Drop rows the tokenizer can never reach (see {@link isFullWord}). */
  fullWordsOnly: boolean;
}

export type PruneDecision = "keep" | "non-word" | "low-freq";

/**
 * Whether a non-rule-covered lexicon row should stay in the production lexicon.
 *
 * Rule-covered words are routed to the rule index before this is consulted, so a
 * "drop" here means the word falls through to morphology/generic rules and its
 * pronunciation may diverge from NST.
 */
export function pruneDecision(
  word: string,
  freq: FrequencyTable | null,
  policy: PrunePolicy,
): PruneDecision {
  if (policy.fullWordsOnly && !isFullWord(word)) return "non-word";
  if (policy.minFreq > 0 && freq && freq.frequency(word) < policy.minFreq) return "low-freq";
  return "keep";
}
