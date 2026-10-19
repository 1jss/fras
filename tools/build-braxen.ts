#!/usr/bin/env node
/**
 * Build the compact Braxen subset used by the NST phonetic audit.
 *
 * Source: **Braxen 1.0** (Apache-2.0), `https://github.com/sprakbankental/braxen`
 * — `dict/braxen-sv.tsv`, 96 MB, 857k rows, 27 tab-separated fields:
 *
 *   - `0` orthography
 *   - `1` Base pronunciation (space-separated; see `src/braxen.ts`)
 *   - `2` part of speech / morphology
 *   - `3` language code (ISO 639-2)
 *   - `16` case sensitivity, `26` id
 *
 * We keep `swe` rows whose lowercased orthography is a headword of the full NST
 * lexicon, so the committed table stays small (~368k rows). One JSON-lines record
 * per kept source row: `{w, v, pos, lang}` (gzipped, level 9).
 *
 * Usage:
 *   node tools/build-braxen.ts [--tsv PATH] [--out PATH] [--meta PATH]
 *                              [--lexicon PATH] [--force]
 *
 * `--tsv` points at an already-downloaded file; when absent (or with `--force`)
 * the 96 MB source is downloaded into `data/.cache/` (gitignored).
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

import { parseLexicon } from "../src/lexicon.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BRAXEN_URL =
  "https://raw.githubusercontent.com/sprakbankental/braxen/main/dict/braxen-sv.tsv";
const BRAXEN_LICENSE = "Apache-2.0";
const LANGUAGE = "swe";
const FIELD_COUNT = 27;

interface BraxenMeta {
  source: string;
  url: string;
  license: string;
  fetchedAt: string;
  language: string;
  rows: number;
  malformed: number;
  headwords: number;
  nstHeadwords: number;
  sourceModified: string | null;
}

function parseArgs(argv: string[]) {
  const args = {
    tsv: resolve(ROOT, "data/.cache/braxen-sv.tsv"),
    out: resolve(ROOT, "data/braxen.jsonl.gz"),
    meta: resolve(ROOT, "data/braxen.meta.json"),
    lexicon: resolve(ROOT, "data/nst-lexicon.jsonl.gz"),
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--force") args.force = true;
    else if (key === "--tsv") args.tsv = resolve(argv[++i] ?? "");
    else if (key === "--out") args.out = resolve(argv[++i] ?? "");
    else if (key === "--meta") args.meta = resolve(argv[++i] ?? "");
    else if (key === "--lexicon") args.lexicon = resolve(argv[++i] ?? "");
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

  const nstHeadwords = new Set(parseLexicon(readFileSync(args.lexicon)).keys());

  const records: string[] = [];
  const headwords = new Set<string>();
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
    const w = (f[0] ?? "").toLowerCase();
    if (!w || !nstHeadwords.has(w)) continue;
    headwords.add(w);
    records.push(JSON.stringify({ w, v: f[1] ?? "", pos: f[2] ?? "", lang: LANGUAGE }));
  }

  const raw = records.join("\n") + "\n";
  const gz = gzipSync(Buffer.from(raw, "utf8"), { level: 9 });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, gz);

  const meta: BraxenMeta = {
    source: "Braxen 1.0",
    url: BRAXEN_URL,
    license: BRAXEN_LICENSE,
    fetchedAt: new Date().toISOString(),
    language: LANGUAGE,
    rows: records.length,
    malformed,
    headwords: headwords.size,
    nstHeadwords: nstHeadwords.size,
    sourceModified,
  };
  mkdirSync(dirname(args.meta), { recursive: true });
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `braxen rows read     ${rows}\n` +
      `  swe rows           ${swe}\n` +
      `  malformed          ${malformed}\n` +
      `  kept (NST overlap) ${records.length} (${headwords.size} headwords)\n` +
      `wrote ${args.out} (${gz.length} bytes gz, ${raw.length} bytes raw)\n` +
      `wrote ${args.meta}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
