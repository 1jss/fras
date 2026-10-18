#!/usr/bin/env node
/**
 * Rule-coverage automation over the full NST lexicon.
 *
 * For every headword in `data/nst-lexicon.jsonl.gz`, run the **rule-only** path and
 * compare its phonemes with NST's own transcriptions. A row the rules already
 * reproduce is a "direct replacement" we no longer need to store: the row moves to
 * the rule index, so in production the rules produce it (generalizing instead of
 * memorizing).
 *
 * Classes:
 *   - `matched`        rules reproduce the phonemes *and* the full string -> route
 *   - `structure-only` rules reproduce the phonemes, structure differs    -> route
 *                      + a small entry that restores NST's syllable/stress/compound
 *                      layout (no phonemes stored)
 *   - `miss`           the rules do not reproduce the phonemes -> keep the row
 *
 * Production resolution becomes: overrides -> pruned lexicon -> **rule index**
 * (rules, skipping morphology) -> morphology -> rules. Routing rule-covered words
 * past morphology is what makes them prunable: without it, morphology splits almost
 * any row that is removed.
 *
 * `--write` emits:
 *   - `data/nst-lexicon.pruned.jsonl.gz`  pronunciations the rules cannot produce
 *   - `data/nst-rules.jsonl.gz`           rule-covered words (+ structure correction)
 *   - `data/rule-coverage.jsonl.gz`       per-word classification report
 *
 * and then verifies the written artifacts against NST end to end.
 *
 * Usage:
 *   node tools/prune-lexicon.ts [--write] [--check] [--all|--n N]
 *                               [--examples N] [--report PATH]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  fullLexicon,
  parseLexicon,
  FULL_LEXICON_PATH,
  PRUNED_LEXICON_PATH,
  RULE_INDEX_PATH,
  type Lexicon,
} from "../src/lexicon.ts";
import { applyStructureCorrection, phonemeSequence, phonetizeWord } from "../src/phonetize.ts";
import { applyRules, applyRulesTrace } from "../src/rules/engine.ts";
import { SV_RULES_COMPILED } from "../src/rules/sv-rules.ts";
import { assignStress, syllabify } from "../src/syllable.ts";
import { parseNst } from "../src/sampa.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COVERAGE_PATH = join(ROOT, "data", "rule-coverage.jsonl.gz");

type Status = "matched" | "structure-only" | "miss";

interface Divergence {
  phonemeIndex: number;
  rulesSymbol: string | null;
  nstSymbol: string | null;
  grapheme: string | null;
  ruleOutput: string | null;
}

interface CoverageRecord {
  w: string;
  rules: string;
  variants: string[];
  status: Status;
  divergence: Divergence | null;
}

function parseArgs(argv: string[]) {
  const args = { write: false, check: false, all: false, n: 20000, examples: 20, report: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--check") args.check = true;
    else if (a === "--all") args.all = true;
    else if (a === "--n") args.n = Number(argv[++i]);
    else if (a === "--examples") args.examples = Number(argv[++i]);
    else if (a === "--report") args.report = argv[++i] ?? "";
  }
  return args;
}

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

/** First phoneme where `rules` diverges from `target`, with its source grapheme. */
function firstDivergence(word: string, rules: string, target: string): Divergence | null {
  const a = segments(rules);
  const b = segments(target);
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  if (i === n && a.length === b.length) return null;

  const trace = applyRulesTrace(word, SV_RULES_COMPILED);
  let acc = 0;
  let grapheme: string | null = null;
  let ruleOutput: string | null = null;
  for (const step of trace.steps) {
    const count = segments(step.o).length;
    if (i < acc + count) {
      grapheme = step.grapheme;
      ruleOutput = step.o;
      break;
    }
    acc += count;
  }
  return {
    phonemeIndex: i,
    rulesSymbol: a[i] ?? null,
    nstSymbol: b[i] ?? null,
    grapheme,
    ruleOutput,
  };
}

/** All non-phoneme structure tokens, paired with the phoneme index they precede. */
function structurePrefixes(target: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let prefix = "";
  let index = 0;
  for (const t of parseNst(target)) {
    if (t.type === "phoneme") {
      if (prefix) {
        out.push([index, prefix]);
        prefix = "";
      }
      index += 1;
    } else {
      prefix += t.symbol;
    }
  }
  return out;
}

function missRecord(word: string, variants: string[], ruleSegments: string): CoverageRecord {
  let best = Infinity;
  let target = variants[0] ?? "";
  for (const v of variants) {
    const d = levenshtein(segments(ruleSegments), segments(v));
    if (d < best) {
      best = d;
      target = v;
    }
  }
  return {
    w: word,
    rules: ruleSegments,
    variants,
    status: "miss",
    divergence: firstDivergence(word, ruleSegments, target),
  };
}

interface Classification {
  status: Status;
  record: CoverageRecord;
  prefixes: Array<[number, string]>;
}

function classify(word: string, variants: string[]): Classification {
  const ruleSegments = applyRules(word, SV_RULES_COMPILED);
  const ruleKey = phonemeSequence(ruleSegments);
  const target = variants.find((v) => phonemeSequence(v) === ruleKey);

  if (!target) {
    return { status: "miss", record: missRecord(word, variants, ruleSegments), prefixes: [] };
  }

  const produced = assignStress(syllabify(ruleSegments), 0);
  if (variants.includes(produced)) {
    return {
      status: "matched",
      record: { w: word, rules: ruleSegments, variants, status: "matched", divergence: null },
      prefixes: [],
    };
  }

  return {
    status: "structure-only",
    record: {
      w: word,
      rules: ruleSegments,
      variants,
      status: "structure-only",
      divergence: null,
    },
    prefixes: structurePrefixes(target),
  };
}

function pct(x: number, n: number): string {
  return `${(100 * x / Math.max(n, 1)).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const full = fullLexicon();
  const all = [...full.keys()];
  const stride = args.all ? 1 : Math.max(1, Math.floor(all.length / args.n));
  const sample = args.all ? all : all.filter((_, i) => i % stride === 0);

  const coverage: CoverageRecord[] = [];
  const covered = new Map<string, Array<[number, string]>>();
  const missPatterns = new Map<string, number>();
  const examples: string[] = [];

  let matched = 0;
  let structureOnly = 0;
  let miss = 0;

  for (const w of sample) {
    const entry = full.lookup(w);
    if (!entry) continue;
    const { status, record, prefixes } = classify(w, entry.variants);
    if (args.write || args.report) coverage.push(record);

    if (status === "miss") {
      miss += 1;
      const div = record.divergence;
      if (div) {
        const key = `${div.grapheme ?? "?"} -> ${div.ruleOutput ?? "?"} (want ${div.nstSymbol ?? "?"})`;
        missPatterns.set(key, (missPatterns.get(key) ?? 0) + 1);
        if (examples.length < args.examples) {
          examples.push(`${w}: rules ${record.rules}  (${key})`);
        }
      }
    } else {
      matched += status === "matched" ? 1 : 0;
      structureOnly += status === "structure-only" ? 1 : 0;
      covered.set(w, prefixes);
    }
  }

  const total = matched + structureOnly + miss;
  const prunable = matched + structureOnly;
  process.stdout.write(
    `rule coverage over NST lexicon${args.all ? "" : ` (sampled ${total})`}\n` +
      `  rule-covered    ${prunable} (${pct(prunable, total)})  -> route to rules, prune row\n` +
      `    matched         ${matched} (${pct(matched, total)})  full string matches\n` +
      `    structure-only  ${structureOnly} (${pct(structureOnly, total)})  + structure correction\n` +
      `  miss            ${miss} (${pct(miss, total)})  keep in production lexicon\n`,
  );

  if (missPatterns.size) {
    const top = [...missPatterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    process.stdout.write(
      `\ntop miss patterns (grapheme -> rule output):\n` +
        top.map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`).join("\n") +
        "\n",
    );
  }
  if (examples.length) {
    process.stdout.write(`\nexamples:\n${examples.join("\n")}\n`);
  }

  const coverageText = () => coverage.map((r) => JSON.stringify(r)).join("\n") + "\n";

  if (args.report) {
    writeFileSync(args.report, gzipSync(Buffer.from(coverageText())));
    process.stdout.write(`\nwrote coverage report -> ${args.report}\n`);
  }

  if (args.write) {
    if (!args.all) {
      process.stderr.write(
        "warning: --write without --all prunes only the sampled words; " +
          "use --all (npm run prune:write) for production artifacts\n",
      );
    }
    const pruned: string[] = [];
    const ruleLines: string[] = [];
    for (const w of full.keys()) {
      const e = full.lookup(w);
      if (!e) continue;
      if (covered.has(w)) {
        ruleLines.push(JSON.stringify({ w, prefixes: covered.get(w) ?? [] }));
        continue;
      }
      const rec: { w: string; v: string[]; s?: string } = { w, v: e.variants };
      if (e.segmentation) rec.s = e.segmentation;
      pruned.push(JSON.stringify(rec));
    }
    writeFileSync(PRUNED_LEXICON_PATH, gzipSync(Buffer.from(pruned.join("\n") + "\n"), { level: 9 }));
    writeFileSync(RULE_INDEX_PATH, gzipSync(Buffer.from(ruleLines.join("\n") + "\n"), { level: 9 }));
    writeFileSync(COVERAGE_PATH, gzipSync(Buffer.from(coverageText()), { level: 9 }));
    process.stdout.write(
      `\nwrote ${PRUNED_LEXICON_PATH} (${pruned.length} rows)\n` +
        `wrote ${RULE_INDEX_PATH} (${ruleLines.length} rows)\n` +
        `wrote ${COVERAGE_PATH} (${coverage.length} rows)\n` +
        `full baseline kept at ${FULL_LEXICON_PATH}\n`,
    );
  }

  if (args.check || args.write) verifyProduction();
}

/** Verify the committed production artifacts (pruned lexicon + rule index) vs NST. */
function verifyProduction(): void {
  const full = fullLexicon();
  const prod: Lexicon = existsSync(PRUNED_LEXICON_PATH)
    ? parseLexicon(readFileSync(PRUNED_LEXICON_PATH))
    : full;
  const regressions: string[] = [];
  let checked = 0;
  for (const w of full.keys()) {
    if (prod.lookup(w)) continue; // pronunciation stored; resolution is a lookup
    const e = full.lookup(w);
    if (!e) continue;
    checked += 1;
    const out = phonetizeWord(w).variants[0] ?? "";
    if (!e.variants.includes(out)) {
      regressions.push(`${w}: got ${out}  want ${e.variants.join(" | ")}`);
    }
  }
  if (regressions.length) {
    process.stdout.write(
      `\nCHECK FAILED: ${regressions.length}/${checked} rule-routed words regressed:\n` +
        regressions.slice(0, 20).join("\n") +
        "\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`\ncheck OK: all ${checked} rule-routed words reproduce NST\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
