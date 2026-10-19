/**
 * Runtime access to the compact NST lexicon built by `tools/build-lexicon.ts`.
 *
 * Records are gzipped JSON-lines: `{"w": headword, "v": [pronunciation], "s": seg?}`.
 * The committed build stores one preferred pronunciation per word; `--all-variants`
 * builds may contain more. Loaded lazily and cached for the process lifetime.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export interface LexiconEntry {
  /** NST SAMPA pronunciations; the first is preferred (one in the default build). */
  variants: string[];
  /** Compound segmentation (field 3) when it contains `+`. */
  segmentation?: string;
}

export interface Lexicon {
  lookup(word: string): LexiconEntry | null;
  readonly size: number;
  /** Raw headwords (lowercased), for building/tests. */
  keys(): IterableIterator<string>;
}

/** Walk up from `start` to the directory holding `package.json`. */
function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** The full NST lexicon (source of truth for comparisons). */
export const FULL_LEXICON_PATH = join(ROOT, "data", "nst-lexicon.jsonl.gz");
/** Production lexicon: only the rows rules cannot reproduce. */
export const PRUNED_LEXICON_PATH = join(ROOT, "data", "nst-lexicon.pruned.jsonl.gz");
/**
 * Words the rules reproduce: routed to the rule layer (skipping morphology), with
 * an optional structure correction for the ones whose syllable/stress layout the
 * rules do not match.
 */
export const RULE_INDEX_PATH = join(ROOT, "data", "nst-rules.jsonl.gz");

const DEFAULT_PATH = FULL_LEXICON_PATH;

interface RawRecord {
  w: string;
  v: string[];
  s?: string;
}

class MapLexicon implements Lexicon {
  readonly #map: Map<string, LexiconEntry>;

  constructor(map: Map<string, LexiconEntry>) {
    this.#map = map;
  }

  lookup(word: string): LexiconEntry | null {
    return this.#map.get(word.toLowerCase()) ?? null;
  }

  get size(): number {
    return this.#map.size;
  }

  keys(): IterableIterator<string> {
    return this.#map.keys();
  }
}

/** Parse a gzipped JSON-lines buffer into a lexicon. */
export function parseLexicon(gz: Buffer): Lexicon {
  const text = gunzipSync(gz).toString("utf8");
  const map = new Map<string, LexiconEntry>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as RawRecord;
    const entry: LexiconEntry = { variants: rec.v };
    if (rec.s) entry.segmentation = rec.s;
    map.set(rec.w, entry);
  }
  return new MapLexicon(map);
}

let cached: Lexicon | null = null;
let cachedFull: Lexicon | null = null;
let cachedRules: RuleIndex | null = null;

/**
 * Load the full NST lexicon (cached). This is the comparison baseline: every
 * pruning/rule change is scored against it, so it must never be pruned itself.
 */
export function fullLexicon(): Lexicon {
  if (cachedFull) return cachedFull;
  if (!existsSync(DEFAULT_PATH)) {
    throw new Error(
      `lexicon not found at ${DEFAULT_PATH}; run: npm run build:lexicon`,
    );
  }
  cachedFull = parseLexicon(readFileSync(DEFAULT_PATH));
  return cachedFull;
}

/**
 * Load the production lexicon (cached): the pruned lexicon when it has been
 * built, otherwise the full lexicon. Words pruned from it are routed to the rules
 * by the rule index.
 */
export function lexicon(): Lexicon {
  if (cached) return cached;
  const path = existsSync(PRUNED_LEXICON_PATH) ? PRUNED_LEXICON_PATH : DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `lexicon not found at ${path}; run: npm run build:lexicon`,
    );
  }
  cached = parseLexicon(readFileSync(path));
  return cached;
}

/**
 * An entry in the rule index: a word whose *phonemes* the rules already reproduce.
 * It is routed to the rule layer, and `prefixes` restores NST's structure when the
 * rules lay out syllables/stress/compounds differently. Matched words carry an
 * empty `prefixes` (routing only).
 */
export interface RuleEntry {
  /**
   * `[phonemeIndex, prefix]` pairs, where `prefix` is the run of structure tokens
   * (`$`, `"`, `""`, `%`, `¤`, `_`) that precede that phoneme in NST.
   */
  prefixes: Array<[number, string]>;
}

export interface RuleIndex {
  lookup(word: string): RuleEntry | null;
  readonly size: number;
}

interface RawRuleRecord {
  w: string;
  prefixes: Array<[number, string]>;
}

const EMPTY_RULE_INDEX: RuleIndex = {
  lookup: () => null,
  get size() {
    return 0;
  },
};

/** Parse a gzipped JSON-lines rule index. */
export function parseRuleIndex(gz: Buffer): RuleIndex {
  const text = gunzipSync(gz).toString("utf8");
  const map = new Map<string, RuleEntry>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as RawRuleRecord;
    map.set(rec.w, { prefixes: rec.prefixes });
  }
  return {
    lookup: (word) => map.get(word.toLowerCase()) ?? null,
    get size() {
      return map.size;
    },
  };
}

/** Load the rule index (cached); empty when it has not been built. */
export function ruleIndex(): RuleIndex {
  if (cachedRules) return cachedRules;
  if (!existsSync(RULE_INDEX_PATH)) {
    cachedRules = EMPTY_RULE_INDEX;
    return cachedRules;
  }
  cachedRules = parseRuleIndex(readFileSync(RULE_INDEX_PATH));
  return cachedRules;
}
