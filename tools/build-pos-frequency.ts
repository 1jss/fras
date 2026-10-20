#!/usr/bin/env node
/**
 * Build the compact POS-conditioned frequency table used for reading selection
 * and usage pruning.
 *
 * Source: Språkbanken's *Corpus word statistics* (CC-BY-4.0),
 * `https://svn.spraakbanken.gu.se/sb-arkiv/pub/frekvens/stats_all.txt.zip` — a
 * gzipped single-file archive whose rows are
 *
 *   word form <TAB> part-of-speech (SUC/MSD, dot-separated) <TAB> ... <TAB>
 *   raw frequency <TAB> per-million frequency
 *
 * sorted by raw frequency descending. The tagset is the one Braxen uses, with
 * spaces instead of dots (`VB.PRS.AKT` ↔ `VB PRS AKT`).
 *
 * We stream the archive **without loading it into memory** (the entry is 5.5 GB
 * uncompressed), stop at the per-million cutoff and keep one `(word, tag)` row
 * per dictionary headword, summing over the particle/compound lemgram rows the
 * source lists separately. Output is a gzipped `word<TAB>tag<TAB>frequency`
 * table, restricted to full-word headwords of Braxen ∪ NST so it stays small.
 *
 * Usage:
 *   node tools/build-pos-frequency.ts [--zip PATH] [--out PATH] [--meta PATH]
 *                                      [--min-freq X] [--force]
 */

import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createInflateRaw } from "node:zlib";

import { parseLexicon } from "../src/lexicon.ts";
import { isFullWord } from "../src/frequency.ts";
import { serializePosFrequency, type PosFrequencyMeta } from "../src/pos-frequency.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATS_URL = "https://svn.spraakbanken.gu.se/sb-arkiv/pub/frekvens/stats_all.txt.zip";
const STATS_LICENSE = "CC-BY-4.0";
const ENTRY = "stats_all.txt";
const BRAXEN_FIELDS = 27;
const BRAXEN_LANGUAGE = "swe";

function parseArgs(argv: string[]) {
  const args = {
    zip: resolve(ROOT, "data/.cache/stats_all.txt.zip"),
    out: resolve(ROOT, "data/pos-frequency.tsv.gz"),
    meta: resolve(ROOT, "data/pos-frequency.meta.json"),
    braxen: resolve(ROOT, "data/.cache/braxen-sv.tsv"),
    nst: resolve(ROOT, "data/nst-lexicon.jsonl.gz"),
    minFreq: 0.01,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--force") args.force = true;
    else if (key === "--min-freq") args.minFreq = Number(argv[++i]);
    else if (key === "--zip") args.zip = resolve(argv[++i] ?? "");
    else if (key === "--out") args.out = resolve(argv[++i] ?? "");
    else if (key === "--meta") args.meta = resolve(argv[++i] ?? "");
    else if (key === "--braxen") args.braxen = resolve(argv[++i] ?? "");
    else if (key === "--nst") args.nst = resolve(argv[++i] ?? "");
  }
  return args;
}

/** Ask the server for the archive's Last-Modified (best effort). */
async function archiveModified(): Promise<string | undefined> {
  try {
    const res = await fetch(STATS_URL, { method: "HEAD" });
    return res.headers.get("last-modified") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Ensure the archive exists, downloading it if needed (returns Last-Modified). */
async function ensureArchive(path: string, force: boolean): Promise<string | undefined> {
  if (existsSync(path) && !force) return archiveModified();
  mkdirSync(dirname(path), { recursive: true });
  process.stderr.write(`downloading ${STATS_URL} ...\n`);
  const res = await fetch(STATS_URL);
  if (!res.ok || !res.body) throw new Error(`GET ${STATS_URL} -> ${res.status}`);
  const modified = res.headers.get("last-modified") ?? undefined;
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(path),
  );
  return modified;
}

/**
 * Open one entry of a (deflate/stored) ZIP archive as a stream, without holding
 * the archive or the decompressed data in memory. The central directory is read
 * to locate the entry; the compressed byte range is streamed through a raw
 * inflate. 32-bit offsets are enough here (the archive is < 4 GB).
 */
function openZipEntry(zipPath: string, wanted: string): Readable {
  const fd = openSync(zipPath, "r");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65578);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a ZIP archive");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    for (let n = 0; n < count; n += 1) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
      const method = cd.readUInt16LE(p + 10);
      const compressed = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (name === wanted) {
        const local = Buffer.alloc(30);
        readSync(fd, local, 0, 30, localOffset);
        const localNameLen = local.readUInt16LE(26);
        const localExtraLen = local.readUInt16LE(28);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        const source = createReadStream(zipPath, { start, end: start + compressed - 1 });
        return method === 8 ? source.pipe(createInflateRaw()) : source;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(`entry ${wanted} not found in archive`);
  } finally {
    closeSync(fd);
  }
}

/** Full-word headwords of Braxen ∪ NST — the words the table is restricted to. */
async function dictionaryWords(braxenTsv: string, nstPath: string): Promise<Set<string>> {
  const words = new Set<string>();
  if (existsSync(braxenTsv)) {
    const rl = createInterface({
      input: createReadStream(braxenTsv, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line || line === "#") continue;
      const f = line.split("\t");
      if (f.length !== BRAXEN_FIELDS || f[3] !== BRAXEN_LANGUAGE) continue;
      const w = (f[0] ?? "").toLowerCase();
      if (w && isFullWord(w)) words.add(w);
    }
  }
  if (existsSync(nstPath)) {
    const nst = parseLexicon(readFileSync(nstPath));
    for (const w of nst.keys()) if (isFullWord(w)) words.add(w);
  }
  return words;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.minFreq) || args.minFreq < 0) {
    throw new Error(`invalid --min-freq ${args.minFreq}`);
  }
  const modified = await ensureArchive(args.zip, args.force);
  const words = await dictionaryWords(args.braxen, args.nst);

  const byWord = new Map<string, Map<string, number>>();
  const rl = createInterface({ input: openZipEntry(args.zip, ENTRY), crlfDelay: Infinity });
  let scanned = 0;
  for await (const line of rl) {
    if (!line) continue;
    scanned += 1;
    const f = line.split("\t");
    if (f.length < 6) continue;
    const value = Number(f[5]);
    if (!Number.isFinite(value)) continue;
    // The source is sorted by raw frequency descending, so it is safe to stop.
    if (value < args.minFreq) break;
    const word = f[0]!.toLowerCase();
    if (!word || !isFullWord(word) || !words.has(word)) continue;
    const tag = f[1]!;
    let tags = byWord.get(word);
    if (!tags) byWord.set(word, (tags = new Map()));
    tags.set(tag, (tags.get(tag) ?? 0) + value);
  }

  const entries: Array<[string, string, number]> = [];
  for (const [word, tags] of byWord) {
    for (const [tag, value] of tags) entries.push([word, tag, value]);
  }
  const gz = serializePosFrequency(entries);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, gz);

  const meta: PosFrequencyMeta = {
    source: "Corpus word statistics (Språkbanken)",
    url: STATS_URL,
    license: STATS_LICENSE,
    fetchedAt: new Date().toISOString(),
    // Per-million frequencies normalize to 1e6 over the whole corpus.
    totalMass: 1_000_000,
    minFreq: args.minFreq,
    words: byWord.size,
    rows: entries.length,
    lexicon: "Braxen ∪ NST full-word headwords",
  };
  if (modified) meta.archiveModified = modified;
  mkdirSync(dirname(args.meta), { recursive: true });
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `stats rows scanned   ${scanned} (stopped at ${args.minFreq}/M)\n` +
      `word rows in source  ${words.size} (Braxen ∪ NST full words)\n` +
      `kept                 ${byWord.size} words, ${entries.length} (word, tag) rows\n` +
      `wrote ${args.out} (${gz.length} bytes gz)\n` +
      `wrote ${args.meta}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
