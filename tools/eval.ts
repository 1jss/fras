#!/usr/bin/env node
/**
 * Rule-quality evaluation against the NST lexicon.
 *
 * Runs the **rule-only** path (lexicon, morphology and overrides disabled) over
 * NST words and compares the produced NST SAMPA segments with the lexicon's own
 * transcriptions. This is the metric that drives the "rules until they cover
 * NST" goal, and it is the natural training/validation set for a learned model
 * later.
 *
 * Comparison ignores stress marks, syllable (`$`), compound (`¤`) and
 * intra-word (`_`) boundaries, and reports the best of a word's variants.
 *
 * Usage:
 *   node tools/eval.ts [--n 20000] [--all] [--examples 25]
 */

import { lexicon } from "../src/lexicon.ts";
import { phonetizeWord } from "../src/phonetize.ts";
import { parseNst } from "../src/sampa.ts";

function segments(s: string): string[] {
  return parseNst(s)
    .filter((t) => t.type === "phoneme")
    .map((t) => t.symbol);
}

function levenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

function parseArgs(argv: string[]) {
  const args = { n: 20000, all: false, examples: 25 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--n") args.n = Number(argv[++i]);
    else if (a === "--examples") args.examples = Number(argv[++i]);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const lex = lexicon();
  const all = [...lex.keys()].filter((k) => /^[a-zåäö]+$/.test(k));
  const stride = args.all ? 1 : Math.max(1, Math.floor(all.length / args.n));
  const sample = args.all ? all : all.filter((_, i) => i % stride === 0);

  let exact = 0;
  let checked = 0;
  let totalDistance = 0;
  let totalLength = 0;
  const examples: string[] = [];

  for (const word of sample) {
    const entry = lex.lookup(word);
    if (!entry) continue;
    checked += 1;
    const produced = segments(phonetizeWord(word, { lexicon: null, morphology: false, overrides: false }).variants[0] ?? "");
    let best = Infinity;
    let bestVariant = "";
    for (const v of entry.variants) {
      const target = segments(v);
      const d = levenshtein(produced, target);
      if (d < best) {
        best = d;
        bestVariant = v;
      }
    }
    totalDistance += best;
    totalLength += Math.max(produced.length, 1);
    if (best === 0) exact += 1;
    else if (examples.length < args.examples) {
      examples.push(
        `${word}: rules ${produced.join("")}  nst ${bestVariant} (d=${best})`,
      );
    }
  }

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  process.stdout.write(
    `rule-only vs NST\n` +
      `  words     ${checked}\n` +
      `  exact     ${exact} (${pct(exact / checked)})\n` +
      `  distance  ${totalDistance} / ${totalLength} phonemes (${pct(totalDistance / totalLength)})\n`,
  );
  if (examples.length) {
    process.stdout.write(`\nexamples:\n${examples.join("\n")}\n`);
  }
}

main();
