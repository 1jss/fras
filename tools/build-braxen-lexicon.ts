#!/usr/bin/env node
/**
 * Build the compact Braxen-derived lexicon used by the runtime pipeline.
 *
 * Source: **Braxen 1.0** (Apache-2.0), `dict/braxen-sv.tsv` (27 tab-separated
 * fields; field 0 orthography, field 1 Base pronunciation, field 2 POS/morphology,
 * field 3 language code).
 *
 * Every `swe` row whose lowercased orthography is a **full word** (a string
 * `src/tokenize.ts` can emit as a single token — see `isFullWord`) becomes one
 * entry. A headword can have several rows (inflections, homographs, proper
 * names), so exactly **one** pronunciation is selected with a deterministic
 * preference:
 *
 *   1. rows spelled exactly like the lowercased headword (not capitalized);
 *   2. **usage** — the POS-conditioned frequency table (`data/pos-frequency.tsv.gz`,
 *      `tools/build-pos-frequency.ts`): the row whose MSD tag is most frequent in
 *      running text wins. Exact-tag matches are preferred; otherwise the row's
 *      POS group (the MSD prefix) is used. Words below the table's cutoff fall
 *      through to the next criteria;
 *   3. function words, then nouns, adjectives, verbs, proper names, acronyms,
 *      participles, everything else;
 *   4. Braxen file order.
 *
 * Usage is what fixes homographs the POS order got wrong (`kan`, `var`, `drog`,
 * `bor`, `läst`): the everyday reading (verb) is far more frequent than the rare
 * noun/khan reading, so no curated override is needed for them.
 *
 * The Braxen Base transcription is converted to canonical NST SAMPA with
 * `braxenToNstSampa()`. The build **asserts** the voice-equivalence invariant
 * for every kept row and aborts on any mismatch:
 *
 *   toVoiceIpa(braxenToNstSampa(base)) === braxenVoiceIpa(base)
 *
 * so the runtime reproduces the Braxen rendering exactly.
 *
 * Usage:
 *   node tools/build-braxen-lexicon.ts [--tsv PATH] [--out PATH] [--meta PATH]
 *                                      [--pos-freq PATH] [--force]
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { braxenToNstSampa, braxenVoiceIpa } from "../src/braxen.ts";
import { isFullWord } from "../src/frequency.ts";
import { parsePosFrequency, posOf, type PosFrequencyTable } from "../src/pos-frequency.ts";
import { toVoiceIpa } from "../src/to-voice-ipa.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BRAXEN_URL =
  "https://raw.githubusercontent.com/sprakbankental/braxen/main/dict/braxen-sv.tsv";
const BRAXEN_LICENSE = "Apache-2.0";
const LANGUAGE = "swe";
const FIELD_COUNT = 27;

/** Braxen row kept for ranking; one preferred entry is written per headword. */
interface Row {
  /** Lowercased headword. */
  w: string;
  /** Braxen Base transcription. */
  base: string;
  /** Field 2, e.g. `NN UTR SIN IND NOM`. */
  tags: string;
  /** Field 0 spelled exactly like the lowercased headword. */
  exact: boolean;
  /** Stable order within the headword. */
  order: number;
}

interface Meta {
  source: string;
  url: string;
  license: string;
  fetchedAt: string;
  language: string;
  rows: number;
  malformed: number;
  swe: number;
  headwords: number;
  converted: number;
  mismatches: number;
  sourceModified: string | null;
  /** POS frequency table used for homograph selection, or null when absent. */
  posFreq: string | null;
  /** Multi-row headwords whose reading was decided by usage. */
  usageSelected: number;
}

/**
 * POS groups that are more likely to be the everyday reading of an ambiguous
 * spelling. This is only the **fallback** when the usage table has no entry for
 * the word; where usage is known it decides (see `makeScorer`), so the previous
 * "nouns precede verbs" rule no longer picks the rare noun reading of `kan`,
 * `var`, `drog`, ...
 */
const FUNCTION_POS = new Set(["DT", "KN", "PN", "PP", "IN", "AB", "RG", "HS", "HP", "HA", "HD"]);
const POS_RANK: Readonly<Record<string, number>> = {
  NN: 1,
  JJ: 2,
  VB: 3,
  PM: 4,
  ACR: 5,
  PC: 6,
};

function posRank(tags: string): number {
  const pos = tags.split(" ")[0] ?? "";
  if (FUNCTION_POS.has(pos)) return 0;
  return POS_RANK[pos] ?? 7;
}

function caseRank(row: Row): number {
  return row.exact ? 0 : 1;
}

/** Braxen tags use spaces; the frequency table uses the same MSD tag with dots. */
function msdTag(tags: string): string {
  // Braxen writes `SUB/OBJ`, the statistics file `SUB+OBJ`; normalize.
  return tags.trim().split(/\s+/).join(".").replace(/\//g, "+");
}

type Scorer = (row: Row) => number;

/**
 * Usage scorer for a headword's candidate rows. Higher wins.
 *
 * Exact MSD-tag matches are used whenever the table has any for the word; this
 * stops a row of a *different* form that merely shares the POS (e.g. `skall`'s
 * `VB PRS SFO` row) from beating the row the usage table actually attests.
 * When the table has no exact tag at all, its POS-group totals are used instead.
 */
function makeScorer(table: PosFrequencyTable | null, word: string, rows: Row[]): Scorer {
  if (!table) return () => 0;
  if (rows.some((r) => table.tagFrequency(word, msdTag(r.tags)) > 0)) {
    return (row) => table.tagFrequency(word, msdTag(row.tags));
  }
  return (row) => table.posFrequency(word, posOf(msdTag(row.tags)));
}

function compareRows(a: Row, b: Row, score: Scorer): number {
  const c = caseRank(a) - caseRank(b);
  if (c !== 0) return c;
  const u = score(b) - score(a);
  if (u !== 0) return u;
  const p = posRank(a.tags) - posRank(b.tags);
  if (p !== 0) return p;
  return a.order - b.order;
}

function parseArgs(argv: string[]) {
  const args = {
    tsv: resolve(ROOT, "data/.cache/braxen-sv.tsv"),
    out: resolve(ROOT, "data/braxen-lexicon.jsonl.gz"),
    meta: resolve(ROOT, "data/braxen-lexicon.meta.json"),
    posFreq: resolve(ROOT, "data/pos-frequency.tsv.gz"),
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--force") args.force = true;
    else if (key === "--tsv") args.tsv = resolve(argv[++i] ?? "");
    else if (key === "--out") args.out = resolve(argv[++i] ?? "");
    else if (key === "--meta") args.meta = resolve(argv[++i] ?? "");
    else if (key === "--pos-freq") args.posFreq = resolve(argv[++i] ?? "");
  }
  return args;
}

/** Ensure `tsvPath` exists, downloading the source if needed (returns Last-Modified). */
async function ensureBraxen(tsvPath: string, force: boolean): Promise<string | null> {
  if (existsSync(tsvPath) && !force) return null;
  mkdirSync(dirname(tsvPath), { recursive: true });
  process.stderr.write(`downloading ${BRAXEN_URL} ...\n`);
  const res = await fetch(BRAXEN_URL);
  if (!res.ok || !res.body) throw new Error(`GET ${BRAXEN_URL} -> ${res.status}`);
  const modified = res.headers.get("last-modified");
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(tsvPath),
  );
  return modified;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceModified = await ensureBraxen(args.tsv, args.force);

  let posFreq: PosFrequencyTable | null = null;
  if (existsSync(args.posFreq)) {
    posFreq = parsePosFrequency(readFileSync(args.posFreq));
  } else {
    process.stderr.write(
      `warning: ${args.posFreq} not found; homographs fall back to the POS order\n` +
        `         (run: npm run frequency)\n`,
    );
  }

  const table = new Map<string, Row[]>();
  let rows = 0;
  let malformed = 0;
  let swe = 0;

  const rl = createInterface({
    input: createReadStream(args.tsv, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rows += 1;
    if (!line || line === "#") continue; // header
    const f = line.split("\t");
    if (f.length !== FIELD_COUNT) {
      malformed += 1;
      continue;
    }
    if (f[3] !== LANGUAGE) continue;
    swe += 1;
    const head = f[0] ?? "";
    const w = head.toLowerCase();
    if (!w || !isFullWord(w)) continue;
    let list = table.get(w);
    if (!list) table.set(w, (list = []));
    list.push({
      w,
      base: f[1] ?? "",
      tags: f[2] ?? "",
      exact: head === w,
      order: list.length,
    });
  }

  const lines: string[] = [];
  let mismatches = 0;
  let usageSelected = 0;
  const examples: string[] = [];
  for (const [w, list] of table) {
    const score = makeScorer(posFreq, w, list);
    list.sort((a, b) => compareRows(a, b, score));
    if (list.length > 1 && score(list[0]!) > 0) usageSelected += 1;
    // Deduplicate identical Base transcriptions (same pronunciation, several POS).
    const base = list[0]!.base;
    const nst = braxenToNstSampa(base);
    const want = braxenVoiceIpa(base);
    const got = toVoiceIpa(nst);
    if (want !== got) {
      mismatches += 1;
      if (examples.length < 10) {
        examples.push(`${w}: ${base} -> ${nst} (want ${want}, got ${got})`);
      }
    }
    lines.push(JSON.stringify({ w, v: [nst] }));
  }

  if (mismatches > 0) {
    process.stderr.write(
      `error: ${mismatches} Braxen rows do not render identically to braxenVoiceIpa:\n` +
        examples.map((e) => `  ${e}`).join("\n") +
        "\n",
    );
    process.exitCode = 1;
    return;
  }

  const raw = lines.join("\n") + "\n";
  const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, gz);

  const meta: Meta = {
    source: "Braxen 1.0",
    url: BRAXEN_URL,
    license: BRAXEN_LICENSE,
    fetchedAt: new Date().toISOString(),
    language: LANGUAGE,
    rows,
    malformed,
    swe,
    headwords: table.size,
    converted: lines.length,
    mismatches,
    sourceModified,
    posFreq: posFreq ? args.posFreq : null,
    usageSelected,
  };
  mkdirSync(dirname(args.meta), { recursive: true });
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `braxen rows read     ${rows}\n` +
      `  swe rows           ${swe}\n` +
      `  malformed          ${malformed}\n` +
      `  full-word headwords ${table.size}\n` +
      `  usage-selected     ${usageSelected} (multi-row homographs)\n` +
      `  voice mismatches   ${mismatches}\n` +
      `wrote ${args.out} (${gz.length} bytes gz, ${raw.length} bytes raw)\n` +
      `wrote ${args.meta}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
