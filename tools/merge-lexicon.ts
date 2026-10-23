#!/usr/bin/env node
/**
 * Merge the Braxen-derived lexicon with the NST baseline.
 *
 * The runtime lexicon is **Braxen-first**: every Braxen full-word headword
 * (`data/braxen-lexicon.jsonl.gz`) is taken as-is. NST
 * (`data/nst-lexicon.jsonl.gz`) then supplies the **fallback**: every NST
 * headword that is a full word and that Braxen does not have is copied over, so
 * no dictionary word is lost.
 *
 * The merge **asserts** that every NST full-word headword resolves in the output
 * and aborts otherwise, then writes:
 *
 *   - `data/lexicon.jsonl.gz`      the merged full lexicon (Braxen + NST fallback)
 *   - `data/lexicon.meta.json`     coverage counts
 *
 * Usage:
 *   node tools/merge-lexicon.ts [--braxen PATH] [--nst PATH] [--out PATH]
 *                               [--meta PATH]
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { isFullWord } from "../src/frequency.ts";
import { parseLexicon, type LexiconEntry } from "../src/lexicon.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Meta {
  source: string;
  generatedAt: string;
  braxenHeadwords: number;
  nstHeadwords: number;
  nstFullWords: number;
  overlap: number;
  nstFallback: number;
  merged: number;
  lost: number;
}

function parseArgs(argv: string[]) {
  const args = {
    braxen: resolve(ROOT, "data/braxen-lexicon.jsonl.gz"),
    nst: resolve(ROOT, "data/nst-lexicon.jsonl.gz"),
    out: resolve(ROOT, "data/lexicon.jsonl.gz"),
    meta: resolve(ROOT, "data/lexicon.meta.json"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--braxen") args.braxen = resolve(argv[++i] ?? "");
    else if (key === "--nst") args.nst = resolve(argv[++i] ?? "");
    else if (key === "--out") args.out = resolve(argv[++i] ?? "");
    else if (key === "--meta") args.meta = resolve(argv[++i] ?? "");
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  for (const path of [args.braxen, args.nst]) {
    if (!existsSync(path)) {
      throw new Error(
        `missing ${path}; run: npm run setup (or npm run build:braxen:lexicon + npm run merge:lexicon)`,
      );
    }
  }

  const braxen = parseLexicon(readFileSync(args.braxen));
  const nst = parseLexicon(readFileSync(args.nst));

  const merged = new Map<string, LexiconEntry>();
  for (const w of braxen.keys()) {
    merged.set(w, braxen.lookup(w)!);
  }

  let nstFullWords = 0;
  let overlap = 0;
  let fallback = 0;
  const lost: string[] = [];
  for (const w of nst.keys()) {
    if (!isFullWord(w)) continue;
    nstFullWords += 1;
    if (merged.has(w)) {
      overlap += 1;
      continue;
    }
    const entry = nst.lookup(w);
    if (!entry) continue;
    merged.set(w, entry);
    fallback += 1;
  }

  // Re-check the union explicitly so the invariant is not an accident of the loop.
  for (const w of nst.keys()) {
    if (isFullWord(w) && !merged.has(w)) lost.push(w);
  }
  if (lost.length > 0) {
    process.stderr.write(
      `error: ${lost.length} NST full-word headwords lost, e.g. ${lost.slice(0, 10).join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const keys = [...merged.keys()].sort();
  const lines = keys.map((w) => {
    const e = merged.get(w)!;
    const rec: { w: string; v: string[]; s?: string } = { w, v: e.variants };
    if (e.segmentation) rec.s = e.segmentation;
    return JSON.stringify(rec);
  });
  const raw = lines.join("\n") + "\n";
  const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, gz);

  const meta: Meta = {
    source: "Braxen 1.0 (preferred) + NST (full-word fallback)",
    generatedAt: new Date().toISOString(),
    braxenHeadwords: braxen.size,
    nstHeadwords: nst.size,
    nstFullWords,
    overlap,
    nstFallback: fallback,
    merged: merged.size,
    lost: lost.length,
  };
  mkdirSync(dirname(args.meta), { recursive: true });
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `merged lexicon\n` +
      `  Braxen headwords   ${braxen.size}\n` +
      `  NST headwords      ${nst.size} (${nstFullWords} full words)\n` +
      `  overlap            ${overlap}\n` +
      `  NST fallback       ${fallback}\n` +
      `  merged             ${merged.size}\n` +
      `  lost               ${lost.length}\n` +
      `wrote ${args.out} (${gz.length} bytes gz, ${raw.length} bytes raw)\n` +
      `wrote ${args.meta}\n`,
  );
}

main();
