/**
 * Braxen 1.0 comparison vocabulary (advisory, build/audit-time only).
 *
 * Nothing in the runtime pipeline (`phonetize.ts` and friends) imports this
 * module. It exists so `tools/audit-nst.ts` can normalize fras's canonical NST
 * SAMPA and Braxen's own *Base* transcription to a shared **standard IPA** and
 * compare segment sequences.
 *
 * The Base -> IPA table is ported from Braxen's `p5m/scripts/braxen_conversion.pl`
 * (`encode`), with two documented deviations:
 *
 * - `g` -> `ɡ` (U+0261): the Perl table lists `g` twice (`ɡ` then ASCII `g`), so
 *   its hash ends on ASCII `g`; we keep the IPA script g so both sides agree.
 * - `r0` is omitted: the Perl encoder drops it (`next if $p eq 'r0'`), because IPA
 *   has no symbol for it.
 *
 * The NST side uses a dedicated standard-IPA map rather than `SV_VOICE_MAP` from
 * `to-voice-ipa.ts`: that map is the pre-espeak-ng-PR#2364 *voice* alphabet, which
 * deliberately renders retroflexes as `r`+`consonant` and the sje-sound as `ʃ`.
 * Comparing through it would turn notation choices into noise.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { parseNst } from "./sampa.ts";
import { SV_VOICE_MAP } from "./to-voice-ipa.ts";

/* -------------------------------------------------------------------------- *
 * Braxen Base -> IPA
 * -------------------------------------------------------------------------- */

/** Braxen Base symbol -> IPA, ported from `braxen_conversion.pl` (`encode`). */
export const BRAXEN_BASE_TO_IPA: Readonly<Record<string, string>> = {
  // plosives
  p: "p",
  b: "b",
  t: "t",
  rt: "ʈ",
  d: "d",
  rd: "ɖ",
  k: "k",
  g: "ɡ", // Perl lists `g` twice; we keep the IPA script g (see module docstring)
  // nasals
  m: "m",
  n: "n",
  rn: "ɳ",
  ng: "ŋ",
  // fricatives
  f: "f",
  v: "v",
  s: "s",
  rs: "ʂ",
  sh: "ʃ",
  zh: "ʒ",
  z: "z",
  dh: "ð",
  th: "θ",
  h: "h",
  x: "ɧ",
  xx: "x",
  c: "ɕ",
  // affricates
  tc: "t͡ʃ",
  dj: "d͡ʒ",
  // approximants / rhotics
  r: "r",
  l: "l",
  rl: "ɭ",
  j: "j",
  w: "w",
  rh: "ɾ",
  rx: "ʀ",
  // `r0`: no IPA; omitted intentionally (the Perl encoder drops it).

  // vowels
  "i:": "iː",
  i: "ɪ",
  ih: "ɪ̯",
  "y:": "yː",
  y: "ʏ",
  "e:": "eː",
  e: "e",
  eh: "e\u031D",
  ex: "ə",
  "ä:": "ɛː",
  "ä": "ɛ",
  "ae:": "æː",
  ae: "æ",
  "ö:": "øː",
  "ö": "ø",
  "oe:": "ɶː",
  oe: "ɶ",
  "u:": "uː",
  u: "u",
  oh: "o",
  "o:": "oː",
  o: "ɔ",
  "uu:": "ʉː",
  uu: "ɵ",
  uuh: "ʉ",
  "uw:": "ʊː",
  uw: "ʊ",
  "a:": "ɑː",
  a: "a",
  "aa:": "aː",
  // diphthongs
  au: "aʊ",
  eu: "ɛʊ",
  ei: "eɪ",
  ai: "aɪ",
  oi: "ɔɪ",
  ou: "əʊ",
  eex: "eə",
  iex: "ɪə",
  uex: "ʊə",
  // nasal vowels
  an: "ã",
  en: "ɛ\u0303",
  on: "o\u0303",
  un: "œ\u0303",
};

/** Every Braxen Base phoneme, longest first (for greedy reference/validation). */
export const BRAXEN_PHONEMES: readonly string[] = Object.keys(BRAXEN_BASE_TO_IPA).sort(
  (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
);

const BASE_BOUNDARIES: ReadonlySet<string> = new Set([".", "-", "~", "|"]);
const BASE_STRESS: ReadonlySet<string> = new Set(["'", '"', ","]);

const STRESS_IPA: Readonly<Record<string, string>> = {
  "'": "ˈ", // accent I
  '"': "ˈ", // accent II (not representable here; collapse to primary)
  ",": "ˌ", // secondary
};

export type BraxenToken =
  | { type: "phoneme"; symbol: string }
  | { type: "stress"; symbol: string }
  | { type: "boundary"; symbol: string };

/**
 * Split a Base transcription into tokens.
 *
 * Base phonemes are space-separated; a stress mark may be glued to the following
 * phoneme (`'aa:`), and syllable/compound/morpheme/word boundaries are standalone
 * tokens. `r0` is dropped, as in the Perl encoder.
 */
export function parseBraxenBase(base: string): BraxenToken[] {
  const tokens: BraxenToken[] = [];
  for (const raw of base.trim().split(/\s+/)) {
    if (!raw) continue;
    if (BASE_BOUNDARIES.has(raw)) {
      tokens.push({ type: "boundary", symbol: raw });
      continue;
    }
    let rest = raw;
    while (rest.length > 0 && BASE_STRESS.has(rest[0]!)) {
      tokens.push({ type: "stress", symbol: rest[0]! });
      rest = rest.slice(1);
    }
    if (!rest || rest === "r0") continue; // r0 has no IPA
    tokens.push({ type: "phoneme", symbol: rest });
  }
  return tokens;
}

/** IPA segments of a Base transcription (stress and boundaries dropped). */
export function braxenSegments(base: string): string[] {
  const out: string[] = [];
  for (const t of parseBraxenBase(base)) {
    if (t.type === "phoneme") out.push(BRAXEN_BASE_TO_IPA[t.symbol] ?? t.symbol);
  }
  return out;
}

export interface BraxenToIpaOptions {
  /** Emit stress marks (default: false). */
  stress?: boolean;
}

/** Render a Base transcription as concatenated IPA (boundaries dropped). */
export function braxenToIpa(base: string, options: BraxenToIpaOptions = {}): string {
  const withStress = options.stress ?? false;
  let out = "";
  for (const t of parseBraxenBase(base)) {
    if (t.type === "boundary") continue;
    if (t.type === "stress") {
      if (withStress) out += STRESS_IPA[t.symbol] ?? "";
      continue;
    }
    out += BRAXEN_BASE_TO_IPA[t.symbol] ?? t.symbol;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * NST SAMPA -> IPA (standard reference, independent of the voice profile)
 * -------------------------------------------------------------------------- */

/**
 * NST SAMPA -> standard IPA, chosen to agree with `BRAXEN_BASE_TO_IPA` wherever
 * the two inventories overlap (`t\``≈`rt`, `x\`≈`x`, `s'`≈`c`, `2:`≈`ö:`, ...).
 * `g` maps to the script ɡ, matching the Braxen side.
 */
export const NST_SAMPA_TO_IPA: Readonly<Record<string, string>> = {
  // vowels
  "i:": "iː",
  I: "ɪ",
  "e:": "eː",
  e: "e",
  "E:": "ɛː",
  E: "ɛ",
  "y:": "yː",
  Y: "ʏ",
  "}:": "ʉː",
  u0: "ɵ",
  "u:": "uː",
  U: "ʊ",
  "o:": "oː",
  O: "ɔ",
  "2:": "øː",
  "9": "œ",
  a: "a",
  "A:": "ɑː",
  "@": "ə",
  "a*U": "aʊ",
  "E*U": "ɛʊ",
  // retroflexes
  "t`": "ʈ",
  "d`": "ɖ",
  "n`": "ɳ",
  "l`": "ɭ",
  "s`": "ʂ",
  // sibilants
  "x\\": "ɧ",
  "s'": "ɕ",
  // consonants
  p: "p",
  b: "b",
  t: "t",
  d: "d",
  k: "k",
  g: "ɡ",
  m: "m",
  n: "n",
  N: "ŋ",
  f: "f",
  v: "v",
  r: "r",
  l: "l",
  s: "s",
  h: "h",
  j: "j",
};

/** IPA segments of an NST SAMPA transcription (stress and boundaries dropped). */
export function nstSegments(nst: string): string[] {
  const out: string[] = [];
  for (const t of parseNst(nst)) {
    if (t.type === "phoneme") out.push(NST_SAMPA_TO_IPA[t.symbol] ?? t.symbol);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Voice (Piper) normalization
 *
 * The audit's equivalence is "Piper would produce the same result", so both
 * sides are also rendered in the alphabet fras actually hands to Piper
 * (`SV_VOICE_MAP`, the pre-espeak-ng-PR#2364 voice IPA). Distinctions that this
 * conversion collapses (the four e-sounds, sje/retroflex notation, ...) must not
 * be reported as differences; distinctions it preserves (e.g. the length mark)
 * must.
 * -------------------------------------------------------------------------- */

/**
 * Standard IPA -> voice IPA, derived from the NST side so it stays in sync with
 * `SV_VOICE_MAP`: every IPA value an NST phoneme can produce maps to that
 * phoneme's voice symbol.
 */
const IPA_TO_VOICE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [nst, voice] of Object.entries(SV_VOICE_MAP)) {
    const ipa = NST_SAMPA_TO_IPA[nst];
    if (ipa) map.set(ipa, voice);
  }
  return map;
})();

/**
 * Braxen IPA values the NST side never produces -> the nearest symbol the voice
 * can actually speak. Collapsing (rather than dropping) these is what keeps the
 * audit from flagging a difference Piper could not render; `r0` and unknown
 * Base symbols are already dropped before this point.
 */
const BRAXEN_IPA_TO_VOICE: Readonly<Record<string, string>> = {
  // /e/ family NST cannot express
  "æ": "ɛ",
  "æː": "ɛː",
  "ɶ": "œ",
  "ɶː": "øː",
  "e̝": "ɛ",
  // rounded/back vowels
  "ø": "œ",
  "u": "ʊ",
  "o": "ɔ",
  "ʉ": "ʉː",
  "ʊː": "ʊ",
  // foreign consonants
  "ʒ": "ʃ",
  "ð": "d",
  "θ": "t",
  "z": "s",
  "x": "k",
  "w": "v",
  "ɾ": "r",
  "ʀ": "r",
  "t͡ʃ": "tʃ",
  "d͡ʒ": "dʃ",
  // foreign diphthongs
  "eɪ": "ɛɪ",
  "aɪ": "aɪ",
  "ɔɪ": "ɔɪ",
  "əʊ": "əʊ",
  "eə": "ɛə",
  "ɪə": "ɪə",
  "ʊə": "ʊə",
  // nasal vowels
  "ã": "a",
  "ɛ\u0303": "ɛ",
  "o\u0303": "ɔ",
  "œ\u0303": "œ",
  // length variants with no voice counterpart
  "aː": "ɑː",
  "ɪ̯": "ɪ",
  "ʊ̯": "ʊ",
};

function braxenIpaToVoice(ipa: string): string {
  return IPA_TO_VOICE.get(ipa) ?? BRAXEN_IPA_TO_VOICE[ipa] ?? ipa;
}

/** NST SAMPA -> the voice IPA segments fras emits to Piper (stress/boundaries dropped). */
export function nstVoiceSegments(nst: string): string[] {
  const out: string[] = [];
  for (const t of parseNst(nst)) {
    if (t.type === "phoneme") out.push(SV_VOICE_MAP[t.symbol] ?? t.symbol);
  }
  return out;
}

/** Braxen Base -> the voice IPA segments fras would emit to Piper. */
export function braxenVoiceSegments(base: string): string[] {
  const out: string[] = [];
  for (const t of parseBraxenBase(base)) {
    if (t.type !== "phoneme") continue;
    const ipa = BRAXEN_BASE_TO_IPA[t.symbol];
    if (ipa === undefined) continue;
    const voice = braxenIpaToVoice(ipa);
    if (voice) out.push(voice);
  }
  return out;
}

export interface BraxenToVoiceIpaOptions {
  /** Emit stress marks (default: true). */
  stress?: boolean;
}

/**
 * Render a Braxen Base transcription as the voice IPA fras hands to Piper,
 * *including* stress marks — the Braxen counterpart of `toVoiceIpa()` for NST.
 *
 * Syllable/compound/morpheme/word boundaries are dropped (the voice alphabet has
 * no symbol for them, exactly as `toVoiceIpa()` drops NST's `$`/`¤`/`_`), stress
 * becomes `ˈ`/`ˌ` where Braxen writes it, and every phoneme goes through the same
 * `braxenIpaToVoice` equivalence `braxenVoiceSegments` uses.
 *
 * Braxen writes the stress mark immediately before the nucleus (`b 'i: . l ex n`
 * -> `bˈiːlən`), which is exactly what espeak-ng does and what the voices were
 * trained on, so no relocation is needed (cf. `toVoiceIpa()`, which likewise
 * emits the mark before the vowel). Used by the advisory listening harness
 * (`tools/audition.ts`).
 */
export function braxenVoiceIpa(
  base: string,
  options: BraxenToVoiceIpaOptions = {},
): string {
  const withStress = options.stress ?? true;
  let out = "";
  for (const t of parseBraxenBase(base)) {
    if (t.type === "boundary") continue;
    if (t.type === "stress") {
      if (withStress) out += STRESS_IPA[t.symbol] ?? "";
      continue;
    }
    const ipa = BRAXEN_BASE_TO_IPA[t.symbol];
    if (ipa === undefined) continue;
    const voice = braxenIpaToVoice(ipa);
    if (voice) out += voice;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Segment comparison (standard IPA + Piper output)
 * -------------------------------------------------------------------------- */

export interface Alignment {
  /** Levenshtein distance between the two segment sequences. */
  distance: number;
  /** Substitution/insertion/deletion pairs, as `[a, b]` ("" side uses `∅`). */
  subs: Array<[string, string]>;
}

/** Align two segment sequences under a segment-equality predicate. */
export function alignSegments(
  a: readonly string[],
  b: readonly string[],
  eq: (x: string, y: string) => boolean,
): Alignment {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) dp[i]![0] = i;
  for (let j = 1; j <= n; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = eq(a[i - 1]!, b[j - 1]!) ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  const subs: Array<[string, string]> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const here = dp[i]![j]!;
    if (i > 0 && j > 0 && here === dp[i - 1]![j - 1]! + (eq(a[i - 1]!, b[j - 1]!) ? 0 : 1)) {
      if (!eq(a[i - 1]!, b[j - 1]!)) subs.push([a[i - 1]!, b[j - 1]!]);
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === dp[i - 1]![j]! + 1) {
      subs.push([a[i - 1]!, "∅"]);
      i -= 1;
    } else {
      subs.push(["∅", b[j - 1]!]);
      j -= 1;
    }
  }
  subs.reverse();
  return { distance: dp[m]![n]!, subs };
}

export type MatchClass = "match" | "inventory" | "real";

export interface SegmentComparison {
  /** Segment distance over standard IPA. */
  strict: number;
  /** Segment distance over the voice (Piper) segments. */
  voice: number;
  /** Standard-IPA substitutions (empty when `strict === 0`). */
  subs: Array<[string, string]>;
  /** Voice-segment substitutions (what Piper would render differently). */
  voiceSubs: Array<[string, string]>;
}

/**
 * Compare two transcriptions as standard IPA (`strict`) and as the voice
 * segments Piper would receive (`voice`). A word can differ in IPA yet be
 * `match`/`inventory` if the difference is converted away on the way to Piper.
 */
export function classifySegments(
  nstIpa: readonly string[],
  braxenIpa: readonly string[],
  nstVoice: readonly string[],
  braxenVoice: readonly string[],
): SegmentComparison {
  const strict = alignSegments(nstIpa, braxenIpa, (x, y) => x === y);
  const voice = alignSegments(nstVoice, braxenVoice, (x, y) => x === y);
  return {
    strict: strict.distance,
    voice: voice.distance,
    subs: strict.subs,
    voiceSubs: voice.subs,
  };
}

/**
 * Bucket a comparison: identical IPA, different IPA but the same Piper output
 * (an inventory/notation difference), or a difference Piper would render
 * differently.
 */
export function matchClass(strict: number, voice: number): MatchClass {
  if (strict === 0) return "match";
  return voice === 0 ? "inventory" : "real";
}

/* -------------------------------------------------------------------------- *
 * Built artifact: `data/braxen.jsonl.gz`
 * -------------------------------------------------------------------------- */

export interface BraxenEntry {
  /** Braxen Base transcription (field 1). */
  base: string;
  /** Part of speech / morphology (field 2). */
  pos: string;
  /** ISO 639-2 language code (field 3). */
  lang: string;
}

interface RawBraxenRecord {
  w: string;
  v: string;
  pos?: string;
  lang?: string;
}

/** Parse the gzipped JSON-lines Braxen subset into headword -> entries. */
export function parseBraxen(gz: Buffer): Map<string, BraxenEntry[]> {
  const text = gunzipSync(gz).toString("utf8");
  const map = new Map<string, BraxenEntry[]>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as RawBraxenRecord;
    const entry: BraxenEntry = {
      base: rec.v,
      pos: rec.pos ?? "",
      lang: rec.lang ?? "",
    };
    const list = map.get(rec.w);
    if (list) list.push(entry);
    else map.set(rec.w, [entry]);
  }
  return map;
}

/** Walk up from `start` to the directory holding `package.json`. */
function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** The committed Braxen subset built by `tools/build-braxen.ts`. */
export const BRAXEN_PATH = join(ROOT, "data", "braxen.jsonl.gz");

let cached: Map<string, BraxenEntry[]> | null = null;

/** Load the Braxen subset (cached). */
export function braxenIndex(): Map<string, BraxenEntry[]> {
  if (cached) return cached;
  if (!existsSync(BRAXEN_PATH)) {
    throw new Error(`braxen table not found at ${BRAXEN_PATH}; run: npm run build:braxen`);
  }
  cached = parseBraxen(readFileSync(BRAXEN_PATH));
  return cached;
}
