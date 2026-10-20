/**
 * POS-conditioned frequency table from Språkbanken's *Corpus word statistics*.
 *
 * `tools/build-pos-frequency.ts` streams `stats_all.txt` (word form, SUC/MSD tag,
 * ..., raw and per-million frequency) and keeps one row per `(word, tag)` above a
 * per-million cutoff, restricted to dictionary headwords. The tag is the SUC/MSD
 * tag with dots (`VB.PRS.AKT`, `NN.UTR.SIN.IND.NOM`, `PM.NOM`) — the same tagset
 * Braxen writes with spaces, so `VB PRS AKT` maps to it by `.`↔` `.
 *
 * The table serves two purposes and therefore replaces the old word-only Flex
 * table:
 *
 *   - **reading selection** — choose the Braxen row to store for a headword: the
 *     one whose tag has the highest usage (`bestTag`, `tagFrequency`);
 *   - **usage pruning** — the per-word rate (`frequency`, summed over tags) feeds
 *     `pruneDecision` unchanged.
 */

import { gunzipSync, gzipSync } from "node:zlib";

import { formatFrequency, type FrequencyTable } from "./frequency.ts";

export interface PosFrequencyMeta {
  source: string;
  url: string;
  license: string;
  fetchedAt: string;
  /** Last-Modified of the upstream archive, when the server sent one. */
  archiveModified?: string;
  /** Per-million mass of the *whole* corpus (the normalization total, 1e6). */
  totalMass: number;
  /** Cutoff applied when building, per million. */
  minFreq: number;
  /** Distinct words kept. */
  words: number;
  /** `(word, tag)` rows kept. */
  rows: number;
  /** Word set the table was restricted to. */
  lexicon: string;
}

export interface PosFrequencyTable extends FrequencyTable {
  /** `(word, tag)` rows in the table. */
  readonly rows: number;
  /** Per-million frequency of a word with an exact dot-separated MSD tag. */
  tagFrequency(word: string, tag: string): number;
  /**
   * Per-million frequency of a word with a POS (the MSD prefix before the first
   * dot), summed over every full tag that belongs to it.
   */
  posFrequency(word: string, pos: string): number;
  /** The tag with the highest frequency for a word, or `null`. */
  bestTag(word: string): string | null;
  /** Every `(tag, value)` pair for a word. */
  tags(word: string): IterableIterator<[string, number]>;
}

/** The POS part of a dot-separated MSD tag (`VB.PRS.AKT` -> `VB`). */
export function posOf(tag: string): string {
  const i = tag.indexOf(".");
  return i < 0 ? tag : tag.slice(0, i);
}

class MapPosFrequency implements PosFrequencyTable {
  readonly #byWord: Map<string, Map<string, number>>;
  readonly #totals: Map<string, number>;
  readonly #mass: number;
  readonly rows: number;

  constructor(byWord: Map<string, Map<string, number>>) {
    this.#byWord = byWord;
    this.#totals = new Map();
    let mass = 0;
    let rows = 0;
    for (const [word, tags] of byWord) {
      let total = 0;
      for (const value of tags.values()) {
        total += value;
        mass += value;
        rows += 1;
      }
      this.#totals.set(word, total);
    }
    this.#mass = mass;
    this.rows = rows;
  }

  frequency(word: string): number {
    return this.#totals.get(word.toLowerCase()) ?? 0;
  }

  tagFrequency(word: string, tag: string): number {
    return this.#byWord.get(word.toLowerCase())?.get(tag) ?? 0;
  }

  posFrequency(word: string, pos: string): number {
    const tags = this.#byWord.get(word.toLowerCase());
    if (!tags) return 0;
    let sum = 0;
    for (const [tag, value] of tags) {
      if (tag === pos || tag.startsWith(`${pos}.`)) sum += value;
    }
    return sum;
  }

  bestTag(word: string): string | null {
    const tags = this.#byWord.get(word.toLowerCase());
    if (!tags) return null;
    let best: string | null = null;
    let bestValue = -1;
    for (const [tag, value] of tags) {
      if (value > bestValue) {
        bestValue = value;
        best = tag;
      }
    }
    return best;
  }

  tags(word: string): IterableIterator<[string, number]> {
    const tags = this.#byWord.get(word.toLowerCase());
    return (tags ?? new Map<string, number>()).entries();
  }

  get size(): number {
    return this.#byWord.size;
  }

  get mass(): number {
    return this.#mass;
  }

  entries(): IterableIterator<[string, number]> {
    return this.#totals.entries();
  }
}

/** Parse a gzipped `word<TAB>tag<TAB>frequency` table. */
export function parsePosFrequency(gz: Buffer): PosFrequencyTable {
  const text = gunzipSync(gz).toString("utf8");
  const byWord = new Map<string, Map<string, number>>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const a = line.indexOf("\t");
    if (a < 0) continue;
    const b = line.indexOf("\t", a + 1);
    if (b < 0) continue;
    const word = line.slice(0, a);
    const tag = line.slice(a + 1, b);
    const value = Number(line.slice(b + 1));
    if (!word || !tag || !Number.isFinite(value)) continue;
    let tags = byWord.get(word);
    if (!tags) byWord.set(word, (tags = new Map()));
    tags.set(tag, (tags.get(tag) ?? 0) + value);
  }
  return new MapPosFrequency(byWord);
}

/** Serialize `(word, tag, value)` rows as a gzipped table, sorted by word then tag. */
export function serializePosFrequency(
  entries: Iterable<[string, string, number]>,
  level = 9,
): Buffer {
  const sorted = [...entries].sort(
    (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
  );
  const raw = sorted.map(([w, t, v]) => `${w}\t${t}\t${formatFrequency(v)}\n`).join("");
  return gzipSync(Buffer.from(raw, "utf8"), { level });
}
