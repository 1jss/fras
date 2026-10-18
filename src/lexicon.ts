/**
 * Runtime access to the compact NST lexicon built by `tools/build-lexicon.ts`.
 *
 * Records are gzipped JSON-lines: `{"w": headword, "v": [variants], "s": seg?}`.
 * Loaded lazily and cached for the process lifetime.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export interface LexiconEntry {
  /** NST SAMPA variants, in source order. */
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
const DEFAULT_PATH = join(ROOT, "data", "nst-lexicon.jsonl.gz");

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

/** Load the default lexicon (cached). */
export function lexicon(): Lexicon {
  if (cached) return cached;
  if (!existsSync(DEFAULT_PATH)) {
    throw new Error(
      `lexicon not found at ${DEFAULT_PATH}; run: npm run build:lexicon`,
    );
  }
  cached = parseLexicon(readFileSync(DEFAULT_PATH));
  return cached;
}
