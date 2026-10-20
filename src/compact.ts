/**
 * Compact binary codec for the production lexicon and rule index.
 *
 * The gzipped JSON-lines artifacts are convenient to build and inspect, but
 * expensive at runtime: parsing them allocates a `Map` of hundreds of thousands
 * of live objects (a `LexiconEntry` with a `variants` array per row). This codec
 * packs the same data into one decompressed buffer with byte-sorted keys, so a
 * lookup is a binary search over bytes and the retained memory is a single
 * `ArrayBuffer`.
 *
 * Layout (little-endian):
 *
 * ```text
 *   header (24 bytes)
 *     u8[4]  magic  "FRAC"
 *     u8     version
 *     u8     kind   (0 = lexicon, 1 = rule index)
 *     u16    reserved
 *     u32    entryCount
 *     u32    keyBytesLength
 *     u32    valueBytesLength
 *     u32    reserved
 *   keyOffsets   u32[entryCount + 1]   offsets into keyBytes
 *   keyBytes     bytes                 UTF-8, sorted ascending by bytes
 *   valueOffsets u32[entryCount + 1]   offsets into valueBytes
 *   valueBytes   bytes
 * ```
 *
 * Sections are 4-byte aligned so the offset arrays become zero-copy views over
 * the decompressed buffer. Keys are sorted by their UTF-8 bytes (not by JS string
 * order), so the binary search and the encoder agree even for astral characters.
 *
 * Values:
 *
 * - lexicon:   `u8 variantCount`, then per variant `u16 len` + bytes, then
 *              `u8 hasSegmentation` and, when set, `u16 len` + bytes;
 * - rule index: `u16 prefixCount`, then per prefix `u32 phonemeIndex`, `u8 len` + bytes.
 */

import { gunzipSync } from "node:zlib";

import type { Lexicon, LexiconEntry, RuleEntry, RuleIndex } from "./lexicon.ts";

const MAGIC = "FRAC";
const VERSION = 1;
const HEADER = 24;
const KIND_LEXICON = 0;
const KIND_RULE_INDEX = 1;

const align4 = (n: number): number => (n + 3) & ~3;

/** Byte-wise comparison of two ranges; `a < b` negative, `a > b` positive. */
function compareRanges(
  a: Buffer,
  a0: number,
  a1: number,
  b: Buffer,
  b0: number,
  b1: number,
): number {
  const an = a1 - a0;
  const bn = b1 - b0;
  const n = an < bn ? an : bn;
  for (let i = 0; i < n; i += 1) {
    const d = a[a0 + i]! - b[b0 + i]!;
    if (d !== 0) return d;
  }
  return an - bn;
}

interface Row {
  key: Buffer;
  value: Buffer;
}

function encode(rows: Row[], kind: number): Buffer {
  const n = rows.length;
  const keyOffStart = HEADER;
  const keyBytesStart = align4(keyOffStart + (n + 1) * 4);
  let keyLen = 0;
  for (const row of rows) keyLen += row.key.length;
  const valOffStart = align4(keyBytesStart + keyLen);
  const valBytesStart = align4(valOffStart + (n + 1) * 4);
  let valueLen = 0;
  for (const row of rows) valueLen += row.value.length;
  const total = valBytesStart + valueLen;

  // Offsets are absolute into the buffer, so the decoder can use them directly.
  const keyOffsets = new Uint32Array(n + 1);
  let ko = keyBytesStart;
  for (let i = 0; i < n; i += 1) {
    keyOffsets[i] = ko;
    ko += rows[i]!.key.length;
  }
  keyOffsets[n] = ko;
  const valueOffsets = new Uint32Array(n + 1);
  let vo = valBytesStart;
  for (let i = 0; i < n; i += 1) {
    valueOffsets[i] = vo;
    vo += rows[i]!.value.length;
  }
  valueOffsets[n] = vo;

  // Zero-filled so the committed artifact is byte-reproducible.
  const out = Buffer.alloc(total);
  out.write(MAGIC, 0, "latin1");
  out.writeUInt8(VERSION, 4);
  out.writeUInt8(kind, 5);
  out.writeUInt16LE(0, 6);
  out.writeUInt32LE(n, 8);
  out.writeUInt32LE(keyLen, 12);
  out.writeUInt32LE(valueLen, 16);
  out.writeUInt32LE(0, 20);

  for (let i = 0; i <= n; i += 1) out.writeUInt32LE(keyOffsets[i]!, keyOffStart + i * 4);
  let p = keyBytesStart;
  for (const row of rows) {
    row.key.copy(out, p);
    p += row.key.length;
  }
  for (let i = 0; i <= n; i += 1) out.writeUInt32LE(valueOffsets[i]!, valOffStart + i * 4);
  p = valBytesStart;
  for (const row of rows) {
    row.value.copy(out, p);
    p += row.value.length;
  }
  return out;
}

function encodeLexiconValue(entry: LexiconEntry): Buffer {
  const parts: Buffer[] = [];
  const variants = entry.variants.slice(0, 255);
  const head = Buffer.allocUnsafe(1);
  head.writeUInt8(variants.length, 0);
  parts.push(head);
  for (const variant of variants) {
    const bytes = Buffer.from(variant, "utf8");
    const len = Buffer.allocUnsafe(2);
    len.writeUInt16LE(bytes.length, 0);
    parts.push(len, bytes);
  }
  const seg = entry.segmentation ? Buffer.from(entry.segmentation, "utf8") : null;
  const flag = Buffer.allocUnsafe(1);
  flag.writeUInt8(seg ? 1 : 0, 0);
  parts.push(flag);
  if (seg) {
    const len = Buffer.allocUnsafe(2);
    len.writeUInt16LE(seg.length, 0);
    parts.push(len, seg);
  }
  return Buffer.concat(parts);
}

function encodeRuleValue(entry: RuleEntry): Buffer {
  const prefixes = entry.prefixes.slice(0, 65535);
  const head = Buffer.allocUnsafe(2);
  head.writeUInt16LE(prefixes.length, 0);
  const parts: Buffer[] = [head];
  for (const [index, prefix] of prefixes) {
    const idx = Buffer.allocUnsafe(4);
    idx.writeUInt32LE(index, 0);
    const bytes = Buffer.from(prefix, "utf8");
    const len = Buffer.allocUnsafe(1);
    len.writeUInt8(bytes.length, 0);
    parts.push(idx, len, bytes);
  }
  return Buffer.concat(parts);
}

/** Build the compact buffer for a lexicon. */
export function encodeCompactLexicon(entries: Iterable<readonly [string, LexiconEntry]>): Buffer {
  const rows: Row[] = [];
  for (const [word, entry] of entries) {
    rows.push({ key: Buffer.from(word, "utf8"), value: encodeLexiconValue(entry) });
  }
  rows.sort((a, b) => Buffer.compare(a.key, b.key));
  return encode(rows, KIND_LEXICON);
}

/** Build the compact buffer for a rule index. */
export function encodeCompactRuleIndex(entries: Iterable<readonly [string, RuleEntry]>): Buffer {
  const rows: Row[] = [];
  for (const [word, entry] of entries) {
    rows.push({ key: Buffer.from(word, "utf8"), value: encodeRuleValue(entry) });
  }
  rows.sort((a, b) => Buffer.compare(a.key, b.key));
  return encode(rows, KIND_RULE_INDEX);
}

/** Copy a decompressed buffer to an aligned `ArrayBuffer` for typed-array views. */
function decodeToArrayBuffer(gz: Buffer): ArrayBuffer {
  const raw = gunzipSync(gz);
  const ab = new ArrayBuffer(raw.length);
  new Uint8Array(ab).set(raw);
  return ab;
}

/** Shared reader over a compact buffer: header validation + binary-search lookup. */
abstract class CompactTable {
  protected readonly buf: Buffer;
  protected readonly keyOffsets: Uint32Array;
  protected readonly valueOffsets: Uint32Array;
  readonly size: number;
  #scratch: Buffer;

  constructor(gz: Buffer, kind: number) {
    const ab = decodeToArrayBuffer(gz);
    const buf = Buffer.from(ab);
    if (buf.length < HEADER || buf.toString("latin1", 0, 4) !== MAGIC) {
      throw new Error("compact lexicon: bad magic (not a fras compact artifact)");
    }
    const version = buf.readUInt8(4);
    if (version !== VERSION) {
      throw new Error(`compact lexicon: unsupported version ${version} (expected ${VERSION})`);
    }
    const fileKind = buf.readUInt8(5);
    if (fileKind !== kind) {
      throw new Error(
        `compact lexicon: kind ${fileKind} does not match expected ${kind} ` +
          `(0 = lexicon, 1 = rule index)`,
      );
    }
    this.buf = buf;
    this.size = buf.readUInt32LE(8);
    const keyLen = buf.readUInt32LE(12);
    const keyBytesStart = align4(HEADER + (this.size + 1) * 4);
    const valOffStart = align4(keyBytesStart + keyLen);
    this.keyOffsets = new Uint32Array(ab, HEADER, this.size + 1);
    this.valueOffsets = new Uint32Array(ab, valOffStart, this.size + 1);
    this.#scratch = Buffer.allocUnsafe(1024);
  }

  /** Index of `word` (lowercased), or -1. */
  protected find(word: string): number {
    const lower = word.toLowerCase();
    let query = this.#scratch;
    if (Buffer.byteLength(lower, "utf8") > query.length) query = Buffer.from(lower, "utf8");
    const queryLen = query.write(lower, 0, "utf8");
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareRanges(
        this.buf,
        this.keyOffsets[mid]!,
        this.keyOffsets[mid + 1]!,
        query,
        0,
        queryLen,
      );
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  protected key(i: number): string {
    return this.buf.toString("utf8", this.keyOffsets[i]!, this.keyOffsets[i + 1]!);
  }
}

class CompactLexicon extends CompactTable implements Lexicon {
  constructor(gz: Buffer) {
    super(gz, KIND_LEXICON);
  }

  lookup(word: string): LexiconEntry | null {
    const i = this.find(word);
    return i < 0 ? null : this.#decode(i);
  }

  #decode(i: number): LexiconEntry {
    let p = this.valueOffsets[i]!;
    const count = this.buf.readUInt8(p);
    p += 1;
    const variants: string[] = new Array(count);
    for (let k = 0; k < count; k += 1) {
      const len = this.buf.readUInt16LE(p);
      p += 2;
      variants[k] = this.buf.toString("utf8", p, p + len);
      p += len;
    }
    const entry: LexiconEntry = { variants };
    const hasSegmentation = this.buf.readUInt8(p);
    p += 1;
    if (hasSegmentation) {
      const len = this.buf.readUInt16LE(p);
      p += 2;
      entry.segmentation = this.buf.toString("utf8", p, p + len);
    }
    return entry;
  }

  *keys(): IterableIterator<string> {
    for (let i = 0; i < this.size; i += 1) yield this.key(i);
  }
}

const EMPTY_RULE_ENTRY: RuleEntry = { prefixes: [] };

class CompactRuleIndex extends CompactTable implements RuleIndex {
  constructor(gz: Buffer) {
    super(gz, KIND_RULE_INDEX);
  }

  lookup(word: string): RuleEntry | null {
    const i = this.find(word);
    return i < 0 ? null : this.#decode(i);
  }

  #decode(i: number): RuleEntry {
    let p = this.valueOffsets[i]!;
    const count = this.buf.readUInt16LE(p);
    p += 2;
    if (count === 0) return EMPTY_RULE_ENTRY;
    const prefixes: Array<[number, string]> = new Array(count);
    for (let k = 0; k < count; k += 1) {
      const index = this.buf.readUInt32LE(p);
      p += 4;
      const len = this.buf.readUInt8(p);
      p += 1;
      prefixes[k] = [index, this.buf.toString("utf8", p, p + len)];
      p += len;
    }
    return { prefixes };
  }
}

/** Parse a gzipped compact lexicon. */
export function parseCompactLexicon(gz: Buffer): Lexicon {
  return new CompactLexicon(gz);
}

/** Parse a gzipped compact rule index. */
export function parseCompactRuleIndex(gz: Buffer): RuleIndex {
  return new CompactRuleIndex(gz);
}
