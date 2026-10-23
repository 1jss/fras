#!/usr/bin/env node
/**
 * Rebuild the committed dictionary resources from the upstream sources.
 *
 * This is the one command that walks the whole pipeline: convert Braxen to the
 * canonical NST SAMPA lexicon, merge in the frozen NST fallback, then prune to
 * the production lexicon + rule index and pack the compact runtime artifacts.
 *
 * You almost certainly do not need it: the built resources are committed under
 * `data/`, so a fresh checkout (plus `npm install`) already works. Run this only
 * to refresh them after bumping a source or changing a build tool.
 *
 * The NST baseline (`data/nst-lexicon.jsonl.gz`) is **frozen** and never rebuilt
 * here; it is the committed input the merge consumes.
 *
 * Usage:
 *   npm run setup [-- --force] [-- --min-freq 0.01] [-- --skip-frequency]
 *                 [-- --from merge:lexicon]
 *
 * Flags:
 *   --force             rebuild steps even when their outputs already exist
 *   --min-freq <x>      prune cutoff, per million (default 0.01)
 *   --skip-frequency    keep the existing data/pos-frequency.tsv.gz
 *   --from <step>       start at a named step (skips everything before it)
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data");

interface Step {
  /** Stable name, used by `--from`. */
  name: string;
  /** Tool to run, relative to the repo root. */
  script: string;
  /** Human-readable one-liner. */
  about: string;
  /** Inputs that must exist for the step to make sense. */
  inputs: string[];
  /** Extra CLI args passed to the tool. */
  args?: string[];
  /** Commit-worthy outputs; the step is skipped when all exist. */
  outputs: string[];
}

interface Args {
  force: boolean;
  minFreq: number;
  skipFrequency: boolean;
  from: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, minFreq: 0.01, skipFrequency: false, from: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--skip-frequency") args.skipFrequency = true;
    else if (a === "--min-freq") args.minFreq = Number(argv[++i]);
    else if (a === "--from") args.from = argv[++i] ?? "";
  }
  return args;
}

function steps(minFreq: number): Step[] {
  return [
    {
      name: "frequency",
      script: "tools/build-pos-frequency.ts",
      about: "download Språkbanken corpus statistics -> POS frequency table",
      inputs: [],
      outputs: [join(DATA, "pos-frequency.tsv.gz")],
    },
    {
      name: "build:braxen:lexicon",
      script: "tools/build-braxen-lexicon.ts",
      about: "Braxen Base -> canonical NST SAMPA (usage-ranked homographs)",
      inputs: [join(DATA, "pos-frequency.tsv.gz")],
      outputs: [join(DATA, "braxen-lexicon.jsonl.gz")],
    },
    {
      name: "merge:lexicon",
      script: "tools/merge-lexicon.ts",
      about: "Braxen-first + frozen NST fallback (asserts no word lost)",
      inputs: [join(DATA, "braxen-lexicon.jsonl.gz"), join(DATA, "nst-lexicon.jsonl.gz")],
      outputs: [join(DATA, "lexicon.jsonl.gz")],
    },
    {
      name: "prune:write",
      script: "tools/prune-lexicon.ts",
      about: "rules + usage prune -> production lexicon, rule index, compact artifacts",
      inputs: [join(DATA, "lexicon.jsonl.gz"), join(DATA, "pos-frequency.tsv.gz")],
      args: ["--write", "--all", "--min-freq", String(minFreq), "--full-words-only"],
      outputs: [
        join(DATA, "lexicon.pruned.jsonl.gz"),
        join(DATA, "rules.jsonl.gz"),
        join(DATA, "lexicon.pruned.compact.gz"),
        join(DATA, "rules.compact.gz"),
      ],
    },
  ];
}

function rel(path: string): string {
  return path.startsWith(ROOT) ? path.slice(ROOT.length) : path;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const all = steps(args.minFreq);

  if (!existsSync(join(ROOT, "node_modules"))) {
    process.stderr.write("error: dependencies are not installed; run: npm install\n");
    process.exitCode = 1;
    return;
  }
  const nst = join(DATA, "nst-lexicon.jsonl.gz");
  if (!existsSync(nst)) {
    process.stderr.write(
      `error: missing the frozen NST baseline at ${rel(nst)}; restore it from the repository\n`,
    );
    process.exitCode = 1;
    return;
  }

  let start = 0;
  if (args.from) {
    const i = all.findIndex((s) => s.name === args.from);
    if (i < 0) {
      process.stderr.write(
        `error: unknown step "${args.from}"; choose one of: ${all.map((s) => s.name).join(", ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    start = i;
  }

  const width = String(all.length).length;
  process.stdout.write(`fras setup: rebuilding dictionary resources\n`);
  process.stdout.write(`  min-freq ${args.minFreq}/M${args.force ? ", force" : ""}\n\n`);

  for (let i = 0; i < all.length; i += 1) {
    const step = all[i]!;
    const label = `${String(i + 1).padStart(width)}/${all.length} ${step.name}`;

    if (i < start) {
      process.stdout.write(`${label}  (skipped: before --from)\n`);
      continue;
    }
    if (args.skipFrequency && step.name === "frequency") {
      process.stdout.write(`${label}  (skipped: --skip-frequency)\n`);
      continue;
    }
    const missing = step.inputs.filter((p) => !existsSync(p));
    if (missing.length) {
      process.stderr.write(
        `error: ${step.name} needs ${missing.map(rel).join(", ")}; run the earlier steps first\n`,
      );
      process.exitCode = 1;
      return;
    }
    const done = step.outputs.every((p) => existsSync(p));
    if (done && !args.force) {
      process.stdout.write(`${label}  (up to date: ${step.outputs.map(rel).join(", ")})\n`);
      continue;
    }

    process.stdout.write(`${label}  ${step.about}\n`);
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [join(ROOT, step.script), ...(step.args ?? [])],
      { cwd: ROOT, stdio: "inherit" },
    );
    if (result.error || result.status !== 0) {
      process.stderr.write(
        `\nerror: ${step.name} failed${result.error ? `: ${result.error.message}` : ""}\n`,
      );
      process.exitCode = result.status ?? 1;
      return;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`      done in ${secs}s\n\n`);
  }

  process.stdout.write("setup complete: dictionary resources are rebuilt\n");
}

main();
