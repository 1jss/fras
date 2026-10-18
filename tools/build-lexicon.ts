#!/usr/bin/env node
/**
 * Build the compact fras lexicon from the raw NST pronunciation lexicon.
 *
 * Source: `swe030224NST.pron` — 927,167 lines, 51 `;`-separated fields, latin-1.
 * Field 0 is the headword, field 11 the pronunciation (NST SAMPA), field 15 a
 * second variant when present, field 3 a morphological segmentation when it
 * carries compound `+` markers.
 *
 * The result is a gzipped JSON-lines file (one record per headword, all variants
 * preserved) that the runtime loads instead of the 177 MB raw file.
 *
 * Usage:
 *   node tools/build-lexicon.ts [--pron PATH] [--out PATH]
 */

import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Record {
  /** Lowercased headword. */
  w: string;
  /** NST SAMPA variants, in source order, deduplicated. */
  v: string[];
  /** Compound segmentation (field 3) when it contains `+`. */
  s?: string;
}

function parseArgs(argv: string[]) {
  const args = { pron: resolve(ROOT, "swe030224NST.pron"), out: resolve(ROOT, "data/nst-lexicon.jsonl.gz") };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value) break;
    if (key === "--pron") args.pron = resolve(value);
    else if (key === "--out") args.out = resolve(value);
  }
  return args;
}

async function main(): Promise<void> {
  const { pron, out } = parseArgs(process.argv.slice(2));
  const table = new Map<string, Record>();
  const seenVariants = new Map<string, Set<string>>();

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
    const pron11 = f[11]!;
    if (!head || !pron11) {
      skipped += 1;
      continue;
    }
    const key = head.toLowerCase();
    let rec = table.get(key);
    if (!rec) {
      rec = { w: key, v: [] };
      table.set(key, rec);
      seenVariants.set(key, new Set());
    }
    const seen = seenVariants.get(key)!;
    const variants = f.length > 15 && f[15] ? [pron11, f[15]!] : [pron11];
    for (const v of variants) {
      if (!v || seen.has(v)) continue;
      seen.add(v);
      rec.v.push(v);
    }
    if (!rec.s && f[3] && f[3]!.includes("+")) rec.s = f[3]!;
  }

  const keys = [...table.keys()].sort();
  const linesOut: string[] = [];
  for (const key of keys) {
    const rec = table.get(key)!;
    linesOut.push(JSON.stringify(rec));
  }
  const raw = linesOut.join("\n") + "\n";
  const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gz);

  const variants = keys.reduce((n, k) => n + table.get(k)!.v.length, 0);
  process.stderr.write(
    `read ${lines} lines (${skipped} skipped), ${keys.length} headwords, ` +
      `${variants} variants\n` +
      `wrote ${out} (${gz.length} bytes gz, ${raw.length} bytes raw)\n`,
  );
  void statSync(pron);
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
