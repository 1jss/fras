/**
 * Braxen 1.0 Base -> canonical NST SAMPA conversion (build-time only).
 *
 * `tools/build-braxen-lexicon.ts` uses this to turn every Braxen *Base*
 * transcription into the NST SAMPA alphabet the runtime pipeline speaks, so
 * pronunciations can be sourced from Braxen while the rest of fras stays on its
 * canonical representation. The table is chosen so the voice rendering is
 * byte-identical to `braxenVoiceIpa()`:
 *
 *   toVoiceIpa(braxenToNstSampa(base)) === braxenVoiceIpa(base)
 *
 * (around the whole Braxen source, zero mismatches; the build asserts it.)
 *
 * The Base -> IPA table is ported from Braxen's `p5m/scripts/braxen_conversion.pl`
 * (`encode`), with two documented deviations:
 *
 * - `g` -> `ɡ` (U+0261): the Perl table lists `g` twice (`ɡ` then ASCII `g`), so
 *   its hash ends on ASCII `g`; we keep the IPA script g so both sides agree.
 * - `r0` is omitted: the Perl encoder drops it (`next if $p eq 'r0'`), because IPA
 *   has no symbol for it.
 */

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

/* -------------------------------------------------------------------------- *
 * Braxen Base -> NST SAMPA (build-time)
 *
 * Used by `tools/build-braxen-lexicon.ts` so the runtime pipeline can keep its
 * canonical NST SAMPA alphabet while sourcing pronunciations from Braxen. The
 * table is chosen so the voice rendering is byte-identical to
 * `braxenVoiceIpa()`:
 *
 *   toVoiceIpa(braxenToNstSampa(base)) === braxenVoiceIpa(base)
 *
 * (verified over the whole Braxen source, 0 mismatches; the build tool asserts
 * this invariant and aborts otherwise).
 * -------------------------------------------------------------------------- */

/**
 * Braxen Base symbol -> NST SAMPA. Multi-symbol values expand to several NST
 * phonemes (`eu` -> `E*U`, `tc` -> `t` + `x\`, ...) so the Piper output matches.
 */
export const BRAXEN_BASE_TO_NST: Readonly<Record<string, string>> = {
  // plosives / nasals
  p: "p",
  b: "b",
  t: "t",
  rt: "t`",
  d: "d",
  rd: "d`",
  k: "k",
  g: "g",
  m: "m",
  n: "n",
  rn: "n`",
  ng: "N",
  // fricatives / affricates
  f: "f",
  v: "v",
  s: "s",
  rs: "s`",
  sh: "x\\", // ʃ -> sje, the voice renders ʃ for `x\`
  zh: "x\\",
  z: "s",
  dh: "d",
  th: "t",
  h: "h",
  x: "x\\", // ɧ -> sje
  xx: "k",
  c: "s'",
  tc: "tx\\", // t͡ʃ -> t + ʃ
  dj: "dx\\", // d͡ʒ -> d + ʃ
  // approximants / rhotics
  r: "r",
  l: "l",
  rl: "l`",
  j: "j",
  w: "v",
  rh: "r",
  rx: "r",
  // `r0`: no NST symbol; `parseBraxenBase` drops it.
  // vowels
  "i:": "i:",
  i: "I",
  ih: "I",
  "y:": "y:",
  y: "Y",
  "e:": "e:",
  e: "e",
  eh: "e",
  ex: "@",
  "ä:": "E:",
  "ä": "E",
  "ae:": "E:",
  ae: "E",
  "ö:": "2:",
  "ö": "9",
  "oe:": "2:",
  oe: "9",
  "u:": "u:",
  u: "U",
  oh: "O",
  "o:": "o:",
  o: "O",
  "uu:": "}:",
  uu: "u0",
  uuh: "}:",
  "uw:": "U",
  uw: "U",
  "a:": "A:",
  a: "a",
  "aa:": "A:",
  // diphthongs / nasal vowels (expansions preserve the voice rendering)
  au: "a*U",
  eu: "E*U", // ɛʊ collapses to voice eʊ, which NST spells E*U
  ei: "eI",
  ai: "aI",
  oi: "OI",
  ou: "@U",
  eex: "e@",
  iex: "I@",
  uex: "U@",
  an: "a",
  en: "E",
  on: "O",
  un: "9",
};

const BRAXEN_STRESS_TO_NST: Readonly<Record<string, string>> = {
  "'": '"', // accent I
  '"': '""', // accent II
  ",": "%", // secondary
};

const BRAXEN_BOUNDARY_TO_NST: Readonly<Record<string, string>> = {
  ".": "$", // syllable
  "-": "¤", // compound
  "~": "_", // morpheme -> intra-word boundary
  "|": "_", // word boundary
};

/**
 * Render a Braxen Base transcription as canonical NST SAMPA.
 *
 * Stress is left where Braxen writes it (immediately before the nucleus):
 * `toVoiceIpa()` buffers the mark to the next vowel, so relocating it to the
 * syllable onset is unnecessary and one source row breaks when it is moved.
 */
export function braxenToNstSampa(base: string): string {
  let out = "";
  for (const t of parseBraxenBase(base)) {
    if (t.type === "boundary") {
      out += BRAXEN_BOUNDARY_TO_NST[t.symbol] ?? "";
      continue;
    }
    if (t.type === "stress") {
      out += BRAXEN_STRESS_TO_NST[t.symbol] ?? "";
      continue;
    }
    out += BRAXEN_BASE_TO_NST[t.symbol] ?? t.symbol;
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

/* -------------------------------------------------------------------------- *
 * Voice (Piper) normalization
 *
 * The audit's equivalence is "Piper would produce the same result", so both
 * sides are also rendered in the alphabet fras actually hands to Piper
 * (`SV_VOICE_MAP`, the Piper voice alphabet). Distinctions that this
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
 * becomes `ˈ`/`ˌ` where Braxen writes it, and every phoneme goes through
 * `braxenIpaToVoice`.
 *
 * Braxen writes the stress mark immediately before the nucleus (`b 'i: . l ex n`
 * -> `bˈiːlən`), which is how the voices were trained, so no relocation is
 * needed (cf. `toVoiceIpa()`, which likewise
 * emits the mark before the vowel). Used by `tools/build-braxen-lexicon.ts` to
 * assert the voice-equivalence invariant.
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

