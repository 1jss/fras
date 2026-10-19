#!/usr/bin/env node
/**
 * Build the compact fras lexicon from the raw NST pronunciation lexicon.
 *
 * Source: `swe030224NST.pron` — 927,167 lines, 51 `;`-separated fields, latin-1.
 * Field 0 is the headword, field 1 the POS tags, fields 11/15/19/23 the
 * pronunciation variants, field 3 a morphological segmentation when it carries
 * compound `+` markers.
 *
 * NST contains several source entries per lowercased headword: inflections,
 * homographs and proper names. Lowercasing merges them, so the first variant in
 * file order can belong to a rare homograph (e.g. the proper name `Han` before
 * the pronoun `han`). The build therefore selects exactly **one** pronunciation
 * per word using a deterministic preference:
 *
 *   1. entries spelled exactly like the lowercased headword, non-proper-name;
 *   2. exact lowercase proper names;
 *   3. other non-proper-name spellings (acronyms such as `VI`);
 *   4. other proper-name spellings;
 *   5. within a rank: function words, then verbs, then everything else;
 *   6. within that: NST source order.
 *
 * `--all-variants` keeps every variant (preferred first) for analysis; the
 * production build stores one.
 *
 * Usage:
 *   node tools/build-lexicon.ts [--pron PATH] [--out PATH] [--all-variants]
 */

import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Source entries are ranked by headword spelling, POS and file order. */
interface SourceEntry {
  /** Headword spelling as written in NST (case matters for ranking). */
  head: string;
  /** Field 1, e.g. `PN|||UTR-NEU` or `PM|person|SUR`. */
  tags: string;
  /** Exact lowercase spelling (`han`, not `Han`). */
  exact: boolean;
  /** Proper name (`PM...`). */
  properName: boolean;
  /** Pronunciations from fields 11/15/19/23, in NST order. */
  variants: string[];
  /** Stable order within the headword. */
  order: number;
}

interface Record {
  /** Lowercased headword. */
  w: string;
  /** NST SAMPA variants; one unless `--all-variants`. */
  v: string[];
  /** Compound segmentation (field 3) when it contains `+`. */
  s?: string;
}

/**
 * POS groups that are more likely to be the everyday reading of an ambiguous
 * spelling. Pronouns, determiners, conjunctions, prepositions and adverbs beat
 * homographic nouns; verbs beat homographic nouns (e.g. `drog`, `kan`).
 */
const FUNCTION_POS = new Set([
  "PN", "DT", "KN", "PP", "IN", "AB", "RG", "HS", "HP", "HA", "HD",
]);

function posRank(tags: string): number {
  const pos = tags.split("|")[0] ?? "";
  if (FUNCTION_POS.has(pos)) return 0;
  if (pos === "VB") return 1;
  return 2;
}

function caseRank(entry: SourceEntry): number {
  if (entry.exact && !entry.properName) return 0;
  if (entry.exact && entry.properName) return 1;
  if (!entry.exact && !entry.properName) return 2;
  return 3;
}

/** Rank source entries: common lowercase spelling, function words, NST order. */
function compareEntries(a: SourceEntry, b: SourceEntry): number {
  const c = caseRank(a) - caseRank(b);
  if (c !== 0) return c;
  const p = posRank(a.tags) - posRank(b.tags);
  if (p !== 0) return p;
  return a.order - b.order;
}

function parseArgs(argv: string[]) {
  const args = {
    pron: resolve(ROOT, "swe030224NST.pron"),
    out: resolve(ROOT, "data/nst-lexicon.jsonl.gz"),
    allVariants: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--all-variants") args.allVariants = true;
    else if (key === "--pron") args.pron = resolve(argv[++i] ?? "");
    else if (key === "--out") args.out = resolve(argv[++i] ?? "");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { pron, out } = args;
  const table = new Map<string, SourceEntry[]>();
  const segmentations = new Map<string, string>();

  let lines = 0;
  let skipped = 0;
  const rl = createInterface({
    input: createReadStream(pron, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines += 1;
    if (!line) continue;
    const f = line.split(";");
    if (f.length <= 11) {
      skipped += 1;
      continue;
    }
    const head = f[0]!;
    const pronunciations = [f[11], f[15], f[19], f[23]].filter(
      (v): v is string => Boolean(v),
    );
    if (!head || pronunciations.length === 0) {
      skipped += 1;
      continue;
    }
    const key = head.toLowerCase();
    let entries = table.get(key);
    if (!entries) table.set(key, (entries = []));
    const tags = f[1] ?? "";
    entries.push({
      head,
      tags,
      exact: head === key,
      properName: tags.startsWith("PM"),
      variants: pronunciations,
      order: entries.length,
    });
    if (!segmentations.has(key) && f[3] && f[3]!.includes("+")) {
      segmentations.set(key, f[3]!);
    }
  }

  const keys = [...table.keys()].sort();
  const linesOut: string[] = [];
  let sourceEntries = 0;
  let variantCount = 0;
  for (const key of keys) {
    const entries = table.get(key)!;
    sourceEntries += entries.length;
    entries.sort(compareEntries);

    const variants: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const v of entry.variants) {
        if (!v || seen.has(v)) continue;
        seen.add(v);
        variants.push(v);
        if (!args.allVariants) break;
      }
      if (!args.allVariants && variants.length > 0) break;
    }
    variantCount += variants.length;

    const rec: Record = { w: key, v: variants };
    const segmentation = segmentations.get(key);
    if (segmentation) rec.s = segmentation;
    linesOut.push(JSON.stringify(rec));
  }

  const raw = linesOut.join("\n") + "\n";
  const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gz);

  process.stderr.write(
    `read ${lines} lines (${skipped} skipped), ${keys.length} headwords from ` +
      `${sourceEntries} source entries, ${variantCount} variants ` +
      `(${args.allVariants ? "all variants, preferred first" : "one per word"})\n` +
      `wrote ${out} (${gz.length} bytes gz, ${raw.length} bytes raw)\n`,
  );
  void statSync(pron);
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
