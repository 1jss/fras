#!/usr/bin/env node
/**
 * Build the compact Flex frequency table used for usage-based pruning.
 *
 * Source: Språkbanken's *Flex* frequency lexicon (CC-BY-4.0),
 * `https://spraakbanken.gu.se/resurser/data/flex.csv.zip` — one row per word with
 * per-million frequencies for novel, newspaper and forum. We sum the three corpora
 * and, by default, keep only headwords of the merged lexicon so the committed
 * table stays small (~388k rows, ~2.7 MB gz).
 *
 * Usage:
 *   node tools/build-frequency.ts [--freq PATH] [--out PATH] [--meta PATH]
 *                                 [--lexicon PATH] [--force] [--all]
 *
 * `--freq` points at an already-unpacked `flex.csv`; when absent (or with
 * `--force`) the archive is downloaded and unpacked into `data/.cache/`.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { fullLexicon } from "../src/lexicon.ts";
import { serializeFrequency, type FrequencyMeta } from "../src/frequency.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FLEX_URL = "https://spraakbanken.gu.se/resurser/data/flex.csv.zip";
const FLEX_LICENSE = "CC-BY-4.0";

function parseArgs(argv: string[]) {
  const args = {
    freq: resolve(ROOT, "data/.cache/flex.csv"),
    out: resolve(ROOT, "data/flex-frequency.tsv.gz"),
    meta: resolve(ROOT, "data/flex-frequency.meta.json"),
    lexicon: resolve(ROOT, "data/lexicon.jsonl.gz"),
    force: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--force") args.force = true;
    else if (key === "--all") args.all = true;
    else if (key === "--freq") args.freq = resolve(argv[++i] ?? "");
    else if (key === "--out") args.out = resolve(argv[++i] ?? "");
    else if (key === "--meta") args.meta = resolve(argv[++i] ?? "");
    else if (key === "--lexicon") args.lexicon = resolve(argv[++i] ?? "");
  }
  return args;
}

/** Extract one entry from a (deflate/stored) ZIP archive. */
function extractZipEntry(zip: Buffer, wanted: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 22 - 65536; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = zip.readUInt16LE(off + 10);
    const compressed = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const localOff = zip.readUInt32LE(off + 42);
    const name = zip.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === wanted) {
      const localNameLen = zip.readUInt16LE(localOff + 26);
      const localExtraLen = zip.readUInt16LE(localOff + 28);
      const start = localOff + 30 + localNameLen + localExtraLen;
      const data = zip.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported ZIP method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry ${wanted} not found in archive`);
}

/** Ensure `csvPath` exists, downloading and unpacking the archive if needed. */
async function ensureFlex(csvPath: string, force: boolean): Promise<string | undefined> {
  if (existsSync(csvPath) && !force) return undefined;
  mkdirSync(dirname(csvPath), { recursive: true });
  const zipPath = `${csvPath}.zip`;
  process.stderr.write(`downloading ${FLEX_URL} ...\n`);
  const res = await fetch(FLEX_URL);
  if (!res.ok || !res.body) throw new Error(`GET ${FLEX_URL} -> ${res.status}`);
  const modified = res.headers.get("last-modified") ?? undefined;
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(zipPath),
  );
  writeFileSync(csvPath, extractZipEntry(readFileSync(zipPath), "flex.csv"));
  rmSync(zipPath, { force: true });
  return modified;
}

/** Read Flex: word -> summed per-million frequency, plus the total token mass. */
async function loadFlex(
  path: string,
): Promise<{ freq: Map<string, number>; totalMass: number }> {
  const freq = new Map<string, number>();
  let totalMass = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const f = line.split("\t");
    if (f.length < 4) continue;
    let value = 0;
    for (let i = 1; i <= 3; i += 1) {
      const s = f[i];
      if (!s) continue;
      const n = Number(s);
      if (Number.isFinite(n)) value += n;
    }
    const word = f[0]!.toLowerCase();
    if (!word) continue;
    totalMass += value;
    freq.set(word, (freq.get(word) ?? 0) + value);
  }
  return { freq, totalMass };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const flexModified = await ensureFlex(args.freq, args.force);

  const { freq, totalMass } = await loadFlex(args.freq);

  let entries: Array<[string, number]>;
  let lexicon: string;
  if (args.all) {
    entries = [...freq.entries()];
    lexicon = "(all Flex words)";
  } else {
    const nst = new Set(fullLexicon().keys());
    entries = [...freq.entries()].filter(([w]) => nst.has(w));
    lexicon = basename(args.lexicon);
  }

  const gz = serializeFrequency(entries);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, gz);

  const meta: FrequencyMeta = {
    source: "Flex (Språkbanken)",
    url: FLEX_URL,
    license: FLEX_LICENSE,
    fetchedAt: new Date().toISOString(),
    totalMass,
    rows: entries.length,
    all: args.all,
    lexicon,
  };
  if (flexModified) meta.flexModified = flexModified;
  mkdirSync(dirname(args.meta), { recursive: true });
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `flex words           ${freq.size}\n` +
      `token mass (all)     ${totalMass.toFixed(0)}\n` +
      `rows written         ${entries.length}${args.all ? "" : ` (lexicon headwords only)`}\n` +
      `wrote ${args.out} (${gz.length} bytes gz)\n` +
      `wrote ${args.meta}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
