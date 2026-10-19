#!/usr/bin/env node
/**
 * Audit fras's NST-derived phonetics against Braxen 1.0.
 *
 * Both sides are normalized to a shared **standard IPA** (`src/braxen.ts`) and
 * compared as segment sequences, ignoring stress, syllables, compounds, morphemes
 * and word boundaries. Comparison is best-of-variants: a word matches when any NST
 * variant equals any Braxen entry after normalization.
 *
 * Each word is classified by two distances (Levenshtein over IPA segments):
 *
 *   - `match`      strict distance 0;
 *   - `inventory`  only differs inside declared equivalence classes (the four
 *                  e-sounds, ø/œ, ɧ/ʃ) — a notation/inventory difference;
 *   - `real`       a genuine segment divergence.
 *
 * This is **advisory only**: it does not affect the runtime pipeline.
 *
 * Usage:
 *   node tools/audit-nst.ts [--out PATH] [--meta PATH] [--n N] [--all]
 *                           [--examples N]
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { fullLexicon } from "../src/lexicon.ts";
import {
  braxenIndex,
  braxenSegments,
  braxenVoiceSegments,
  classifySegments,
  matchClass,
  nstSegments,
  nstVoiceSegments,
  type BraxenEntry,
} from "../src/braxen.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type DivergenceClass = "inventory" | "real";

interface AuditRecord {
  w: string;
  nst: string;
  braxen: string;
  pos: string;
  strict: number;
  voice: number;
  class: DivergenceClass;
  subs: Array<[string, string]>;
}

interface AuditMeta {
  source: string;
  generatedAt: string;
  sampled: boolean;
  nstHeadwords: number;
  compared: number;
  uncovered: number;
  matched: number;
  inventory: number;
  real: number;
  meanStrict: number;
  /** Logical model: `inventory` = differs in IPA but collapses to the same Piper input. */
  model: string;
}

function parseArgs(argv: string[]) {
  const args = {
    out: join(ROOT, "data", "braxen-nst-audit.jsonl.gz"),
    meta: join(ROOT, "data", "braxen-nst-audit.meta.json"),
    n: 0,
    examples: 15,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") args.n = 0;
    else if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--meta") args.meta = argv[++i] ?? args.meta;
    else if (a === "--n") args.n = Number(argv[++i]);
    else if (a === "--examples") args.examples = Number(argv[++i]);
  }
  return args;
}

function pct(x: number, n: number): string {
  return `${((100 * x) / Math.max(n, 1)).toFixed(1)}%`;
}

interface Best {
  nst: string;
  entry: BraxenEntry;
  strict: number;
  voice: number;
  subs: Array<[string, string]>;
  voiceSubs: Array<[string, string]>;
  nstLength: number;
  braxenLength: number;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const lex = fullLexicon();
  const braxen = braxenIndex();

  const words = [...lex.keys()];
  const stride = args.n > 0 ? Math.max(1, Math.floor(words.length / args.n)) : 1;
  const sample = args.n > 0 ? words.filter((_, i) => i % stride === 0) : words;

  let compared = 0;
  let matched = 0;
  let inventory = 0;
  let real = 0;
  let strictTotal = 0;
  let strictLength = 0;

  const confusion = new Map<string, number>();
  const records: string[] = [];
  const examples: Record<DivergenceClass, string[]> = { inventory: [], real: [] };

  for (const w of sample) {
    const entries = braxen.get(w);
    if (!entries || entries.length === 0) continue;
    const nstEntry = lex.lookup(w);
    if (!nstEntry) continue;
    compared += 1;

    let best: Best | null = null;
    for (const nstVariant of nstEntry.variants) {
      const nstSegs = nstSegments(nstVariant);
      const nstVoice = nstVoiceSegments(nstVariant);
      for (const entry of entries) {
        const braxenSegs = braxenSegments(entry.base);
        const braxenVoice = braxenVoiceSegments(entry.base);
        const { strict, voice, subs, voiceSubs } = classifySegments(
          nstSegs,
          braxenSegs,
          nstVoice,
          braxenVoice,
        );
        if (
          !best ||
          strict < best.strict ||
          (strict === best.strict && voice < best.voice)
        ) {
          best = {
            nst: nstVariant,
            entry,
            strict,
            voice,
            subs,
            voiceSubs,
            nstLength: nstSegs.length,
            braxenLength: braxenSegs.length,
          };
        }
      }
    }
    if (!best) continue;

    strictTotal += best.strict;
    strictLength += Math.max(best.nstLength, best.braxenLength, 1);

    const cls = matchClass(best.strict, best.voice);
    if (cls === "match") {
      matched += 1;
      continue;
    }
    if (cls === "inventory") inventory += 1;
    else real += 1;

    if (cls === "real") {
      for (const [a, b] of best.voiceSubs) {
        const key = `${a} → ${b}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
    }

    const rec: AuditRecord = {
      w,
      nst: best.nst,
      braxen: best.entry.base,
      pos: best.entry.pos,
      strict: best.strict,
      voice: best.voice,
      class: cls,
      subs: best.subs,
    };
    records.push(JSON.stringify(rec));
    if (examples[cls].length < args.examples) {
      examples[cls].push(
        `${w}: nst ${best.nst} [${nstSegments(best.nst).join("")}]  ` +
          `braxen ${best.entry.base} [${braxenSegments(best.entry.base).join("")}] (d=${best.strict})`,
      );
    }
  }

  const mismatch = inventory + real;
  process.stdout.write(
    `NST vs Braxen 1.0${args.n > 0 ? ` (sampled ${compared})` : ""}\n` +
      `  compared    ${compared} / ${words.length} NST headwords (${pct(compared, words.length)})\n` +
      `  match       ${matched} (${pct(matched, compared)})  identical IPA\n` +
      `  inventory   ${inventory} (${pct(inventory, compared)})  same Piper output, different IPA\n` +
      `  real        ${real} (${pct(real, compared)})  Piper output would differ\n` +
      `  mismatch    ${mismatch} (${pct(mismatch, compared)})\n` +
      `  distance    ${strictTotal} / ${strictLength} IPA segments (${pct(strictTotal, strictLength)})\n`,
  );

  if (confusion.size) {
    const top = [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    process.stdout.write(
      `\ntop Piper substitutions on real differences (nst → braxen):\n` +
        top.map(([k, n]) => `  ${String(n).padStart(7)}  ${k}`).join("\n") +
        "\n",
    );
  }
  for (const cls of ["inventory", "real"] as const) {
    if (!examples[cls].length) continue;
    process.stdout.write(`\n${cls} examples:\n${examples[cls].join("\n")}\n`);
  }

  const gz = gzipSync(Buffer.from(records.join("\n") + (records.length ? "\n" : "")), {
    level: 9,
  });
  writeFileSync(args.out, gz);

  const meta: AuditMeta = {
    source: "NST lexicon vs Braxen 1.0",
    generatedAt: new Date().toISOString(),
    sampled: args.n > 0,
    nstHeadwords: words.length,
    compared,
    uncovered: words.length - compared,
    matched,
    inventory,
    real,
    meanStrict: compared ? strictTotal / compared : 0,
    model:
      "inventory = same Piper input (Braxen Base -> SV_VOICE_MAP collapses the " +
      "difference); real = Piper input differs",
  };
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `\nwrote ${args.out} (${records.length} mismatches, ${gz.length} bytes gz)\n` +
      `wrote ${args.meta}\n`,
  );
}

main();
