#!/usr/bin/env node
/**
 * Frequency dropoff report: where the long tail of the merged lexicon starts.
 *
 * Loads the merged lexicon, its rule-miss storage candidates and the POS
 * frequency table, then shows how much of the stored pronunciation list can be
 * dropped at each frequency threshold — and how much Swedish token coverage that
 * costs. The threshold table is the input for choosing `prune-lexicon.ts
 * --min-freq`.
 *
 * Usage:
 *   node tools/frequency-report.ts [--thresholds 0.01,0.1,1] [--epsilon 0.1]
 *                                  [--examples 5] [--json PATH]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fullLexicon, ruleIndex } from "../src/lexicon.ts";
import { isFullWord } from "../src/frequency.ts";
import { parsePosFrequency, type PosFrequencyMeta } from "../src/pos-frequency.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FREQ_PATH = join(ROOT, "data", "pos-frequency.tsv.gz");
const FREQ_META_PATH = join(ROOT, "data", "pos-frequency.meta.json");

const DEFAULT_THRESHOLDS = [0, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];

function parseArgs(argv: string[]) {
  const args = { thresholds: DEFAULT_THRESHOLDS, epsilon: 0.1, examples: 5, json: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--thresholds") {
      args.thresholds = (argv[++i] ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    } else if (key === "--epsilon") args.epsilon = Number(argv[++i]);
    else if (key === "--examples") args.examples = Number(argv[++i]);
    else if (key === "--json") args.json = argv[++i] ?? "";
  }
  return args;
}

const fmt = (n: number): string => n.toLocaleString("en-US");
const pct = (x: number, n: number): string => `${((100 * x) / Math.max(n, 1)).toFixed(2)}%`;
const pad = (s: string, w: number): string => s.padStart(w);

interface Shape {
  label: string;
  match: (w: string) => boolean;
}

const SHAPES: Shape[] = [
  { label: "full word", match: (w) => isFullWord(w) },
  { label: "multiword/_", match: (w) => w.includes("_") || w.includes(" ") },
  { label: "internal hyphen", match: (w) => !w.startsWith("-") && !w.endsWith("-") && w.includes("-") },
  { label: "prefix x-", match: (w) => w.endsWith("-") },
  { label: "suffix -x", match: (w) => w.startsWith("-") },
  { label: "symbol/digit", match: () => true },
];

function shapeOf(w: string): string {
  for (const s of SHAPES) if (s.match(w)) return s.label;
  return "symbol/digit";
}

function main(): void {
  if (!existsSync(FREQ_PATH) || !existsSync(FREQ_META_PATH)) {
    process.stderr.write(
      `frequency table not found (${FREQ_PATH});\nrun: npm run frequency\n`,
    );
    process.exitCode = 1;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const freq = parsePosFrequency(readFileSync(FREQ_PATH));
  const meta = JSON.parse(readFileSync(FREQ_META_PATH, "utf8")) as PosFrequencyMeta;

  const full = fullLexicon();
  const rules = ruleIndex();
  // The frequency prune acts on the rows the rules cannot reproduce ("rule
  // misses"); deriving them here keeps the report stable regardless of the
  // --min-freq currently baked into the committed production lexicon.
  const fullKeys = [...full.keys()];
  const prodKeys = fullKeys.filter((w) => !rules.lookup(w));
  const allMass = meta.totalMass;
  const prodMass = prodKeys.reduce((m, w) => m + freq.frequency(w), 0);
  const fullMass = fullKeys.reduce((m, w) => m + freq.frequency(w), 0);
  const inUsage = (keys: string[]) => keys.reduce((n, w) => n + (freq.frequency(w) > 0 ? 1 : 0), 0);

  const out: string[] = [];
  const log = (s = ""): void => {
    out.push(s);
  };

  log(`pos-frequency report  (source: ${meta.source}, ${meta.license})`);
  log(`  table ${FREQ_PATH}`);
  log(
    `  ${fmt(freq.size)} words, ${fmt(freq.rows)} (word, tag) rows, ${fmt(Math.round(allMass))} per-million tokens total` +
      `${meta.archiveModified ? `, archive ${meta.archiveModified}` : ""}`,
  );
  log(`  table cut at ${meta.minFreq}/M; words below are absent (not zero)`);

  // 1. Presence
  log(`\npresence`);
  log(
    `  full lexicon           ${pad(fmt(fullKeys.length), 10)}  in usage ${pad(fmt(inUsage(fullKeys)), 10)}` +
      `  absent ${pad(fmt(fullKeys.length - inUsage(fullKeys)), 10)}  mass ${pct(fullMass, allMass)} of all tokens`,
  );
  log(
    `  rule-covered (index)   ${pad(fmt(rules.size), 10)}  routed to the rules, never stored`,
  );
  log(
    `  storage candidates     ${pad(fmt(prodKeys.length), 10)}  in usage ${pad(fmt(inUsage(prodKeys)), 10)}` +
      `  absent ${pad(fmt(prodKeys.length - inUsage(prodKeys)), 10)}  mass ${pct(prodMass, allMass)} of all tokens`,
  );

  // 2. Composition of the storage candidates
  const shapeCount = new Map<string, number>();
  for (const w of prodKeys) shapeCount.set(shapeOf(w), (shapeCount.get(shapeOf(w)) ?? 0) + 1);
  log(`\ncomposition of the storage candidates`);
  for (const s of SHAPES) {
    const n = shapeCount.get(s.label) ?? 0;
    log(`  ${pad(fmt(n), 10)}  ${pct(n, prodKeys.length).padStart(7)}  ${s.label}`);
  }

  // 3. Frequency distribution
  const bucket = (v: number): string => (v <= 0 ? "absent" : `1e${Math.floor(Math.log10(v))}`);
  const hist = new Map<string, number>();
  for (const w of prodKeys) {
    const b = bucket(freq.frequency(w));
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  const order = [
    "absent", "1e-4", "1e-3", "1e-2", "1e-1", "1e0", "1e1", "1e2", "1e3", "1e4",
  ];
  const maxHist = Math.max(...hist.values());
  log(`\nfrequency distribution (storage candidates, per-million)`);
  for (const b of order) {
    const n = hist.get(b) ?? 0;
    log(`  ${b.padStart(6)}  ${pad(fmt(n), 9)}  ${"#".repeat(Math.round((n / maxHist) * 50))}`);
  }

  // 4. Threshold table
  const ranked = [...prodKeys].sort((a, b) => freq.frequency(b) - freq.frequency(a));
  log(`\nthreshold table (usage per-million, summed over POS tags)`);
  log(
    `  ${"thr".padStart(8)}  ${"rows kept".padStart(10)}  ${"%rows".padStart(7)}` +
      `  ${"tok%all".padStart(8)}  ${"tok%prod".padStart(8)}  ${"non-word".padStart(9)}`,
  );
  for (const t of args.thresholds) {
    const kept = ranked.filter((w) => freq.frequency(w) >= t);
    const mass = kept.reduce((m, w) => m + freq.frequency(w), 0);
    const nonWord = kept.reduce((n, w) => n + (isFullWord(w) ? 0 : 1), 0);
    log(
      `  ${String(t).padStart(8)}  ${pad(fmt(kept.length), 10)}  ${pct(kept.length, prodKeys.length).padStart(7)}` +
        `  ${pct(mass, allMass).padStart(8)}  ${pct(mass, prodMass).padStart(8)}  ${pad(fmt(nonWord), 9)}`,
    );
  }

  // 5. Coverage curve + knee
  const blockSize = 5000;
  log(`\ncoverage curve (storage candidates ranked by frequency, blocks of ${fmt(blockSize)})`);
  log(`  ${"rank".padStart(9)}  ${"cum%all".padStart(8)}  ${"marginal%".padStart(9)}`);
  let cum = 0;
  let prev = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    cum += freq.frequency(ranked[i]!);
    if ((i + 1) % blockSize === 0) {
      const marginal = (100 * (cum - prev)) / allMass;
      log(
        `  ${pad(fmt(i + 1), 9)}  ${pct(cum, allMass).padStart(8)}  ${`${marginal.toFixed(4)}%`.padStart(9)}`,
      );
      prev = cum;
    }
    if (i + 1 >= 40 * blockSize) break;
  }
  log(`  (remaining ${fmt(ranked.length - 40 * blockSize)} rows hold the rest)`);

  // Knee: first block whose marginal contribution drops below epsilon.
  let kneeRank: number | null = null;
  cum = 0;
  prev = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    cum += freq.frequency(ranked[i]!);
    if ((i + 1) % blockSize === 0) {
      const marginal = (100 * (cum - prev)) / allMass;
      if (marginal < args.epsilon) {
        kneeRank = i + 1;
        break;
      }
      prev = cum;
    }
  }
  // Elbow: max (y - x) on the normalized cumulative curve.
  let elbowRank = 0;
  let elbowGap = -Infinity;
  cum = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    cum += freq.frequency(ranked[i]!);
    const gap = cum / prodMass - (i + 1) / ranked.length;
    if (gap > elbowGap) {
      elbowGap = gap;
      elbowRank = i + 1;
    }
  }
  log(`\nknee`);
  log(
    `  first block under ${args.epsilon}%/block : rank ${kneeRank === null ? "n/a" : fmt(kneeRank)}` +
      `${kneeRank === null ? "" : ` (${pct(kneeRank, prodKeys.length)} of rows)`}`,
  );
  log(
    `  maximum-convexity elbow           : rank ${fmt(elbowRank)}` +
      ` (${pct(elbowRank, prodKeys.length)} of rows, freq >= ${freq.frequency(ranked[elbowRank - 1] ?? "").toPrecision(3)}/M)`,
  );

  // 6. Boundary examples
  for (const t of args.thresholds) {
    if (t === 0) continue;
    const above: string[] = [];
    const below: string[] = [];
    for (const w of ranked) {
      const v = freq.frequency(w);
      if (v >= t) {
        above.push(`${w}(${v.toPrecision(3)})`);
        if (above.length > args.examples) above.shift();
      } else {
        below.push(`${w}(${v.toPrecision(3)})`);
        if (below.length >= args.examples) break;
      }
    }
    log(`\n  thr >= ${t}:  kept e.g. ${above.join(", ") || "-"}`);
    log(`              dropped e.g. ${below.join(", ") || "-"}`);
  }

  const report = out.join("\n");
  process.stdout.write(`${report}\n`);

  if (args.json) {
    writeFileSync(
      args.json,
      `${JSON.stringify(
        {
          meta,
          presence: {
            full: { rows: fullKeys.length, inUsage: inUsage(fullKeys), mass: fullMass },
            candidates: { rows: prodKeys.length, inUsage: inUsage(prodKeys), mass: prodMass },
            allMass,
          },
          composition: Object.fromEntries(shapeCount),
          thresholds: args.thresholds.map((t) => {
            const kept = ranked.filter((w) => freq.frequency(w) >= t);
            const mass = kept.reduce((m, w) => m + freq.frequency(w), 0);
            return { threshold: t, rows: kept.length, mass };
          }),
          knee: { epsilonRank: kneeRank, elbowRank },
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`\nwrote ${args.json}\n`);
  }
}

main();
