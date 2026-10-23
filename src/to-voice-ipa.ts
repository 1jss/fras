/**
 * Adapter: canonical NST SAMPA -> the IPA alphabet a Piper voice was trained on.
 *
 * The Swedish Piper voices (`sv_SE-alma-medium`, `sv_SE-nst-medium`, ...) were
 * trained on a specific Swedish inventory, and this table emits exactly that:
 *
 * - `r` + `t/d/l/n` is emitted as two phonemes rather than the precomposed
 *   retroflexes `ʈ ɖ ɭ ɳ`, which is how the voices were trained to read them.
 * - the sje-sound is written `ʃ`, not `ɧ`.
 * - stress marks are emitted immediately before the nucleus (`blˈandat`), not at
 *   the syllable onset; an onset-placed mark is voiced as an extra vowel.
 *   See `tokensToIpa`.
 *
 * Everything else is calibrated against the voices' own output (see
 * `tools/audit-voice.ts` for the empirical symbol check).
 */

import { isVowel, parseNst, type NstPhoneme, type NstToken } from "./sampa.ts";

export interface VoiceProfile {
  /** Human-readable voice name. */
  name: string;
  /** NST phoneme symbol -> IPA (may expand to several symbols). */
  map: Readonly<Record<string, string>>;
}

/**
 * Base mapping shared by the Swedish voices. Values were observed from the
 * voices' bundled output, with the voice-inventory corrections applied.
 */
export const SV_VOICE_MAP: Readonly<Record<string, string>> = {
  // long / short vowel pairs
  "i:": "iː",
  I: "ɪ",
  "e:": "eː",
  e: "ɛ", // the voices have no close-mid short e; ɛ is what they speak
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
  "9": "œ", // short ö is  œ, not ø
  a: "a",
  "A:": "ɑː",
  "@": "ə",
  "a*U": "aʊ",
  "E*U": "eʊ",
  // consonants
  p: "p",
  b: "b",
  t: "t",
  d: "d",
  k: "k",
  g: "ɡ", // U+0261 LATIN SMALL LETTER SCRIPT G, what the voices use
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
  // retroflex sources -> split r + consonant (the voices' inventory)
  "t`": "rt",
  "d`": "rd",
  "n`": "rn",
  "l`": "rl",
  // sibilants
  "s`": "ʂ", // rs: kept, the voices have it
  "x\\": "ʃ", // sje: NOT ɧ
  "s'": "ɕ", // kj/tj
};

export const SV_PROFILE: VoiceProfile = {
  name: "sv",
  map: SV_VOICE_MAP,
};

const STRESS: Readonly<Record<string, string>> = {
  accent1: "ˈ",
  accent2: "ˈ", // accent II is not representable; collapse to primary stress
  secondary: "ˌ",
};

export interface ToVoiceIpaOptions {
  profile?: VoiceProfile;
  /** Emit stress marks (default true). */
  stress?: boolean;
  /** Insert a space at NST word boundaries (`_`) inside names/compounds. */
  wordBoundarySpace?: boolean;
}

/** Render a canonical NST SAMPA string as the voice's IPA. */
export function toVoiceIpa(
  nst: string,
  options: ToVoiceIpaOptions = {},
): string {
  const profile = options.profile ?? SV_PROFILE;
  const withStress = options.stress ?? true;
  const tokens = parseNst(nst);
  return tokensToIpa(tokens, profile, withStress, options.wordBoundarySpace ?? false);
}

function tokensToIpa(
  tokens: NstToken[],
  profile: VoiceProfile,
  withStress: boolean,
  wordBoundarySpace: boolean,
): string {
  let out = "";
  // A stress mark is buffered and flushed immediately before the next vowel:
  // the voices were trained with the mark after the onset consonants
  // (`blˈandat`, `tˈɛŋkt`), not at the syllable onset. A mark placed before
  // consonants is voiced by the model as an extra vowel.
  let pendingStress: string | null = null;
  const flushStress = (): void => {
    if (pendingStress === null) return;
    out += pendingStress;
    pendingStress = null;
  };

  for (const t of tokens) {
    if (t.type === "phoneme") {
      if (pendingStress !== null && isVowel(t.symbol as NstPhoneme)) flushStress();
      out += profile.map[t.symbol] ?? t.symbol;
      continue;
    }
    if (t.type === "syllable") continue;
    if (t.type === "compound" || t.type === "word-boundary") {
      flushStress(); // never lose a mark that did not reach a vowel
      if (t.type === "word-boundary" && wordBoundarySpace) out += " ";
      continue;
    }
    if (!withStress) continue;
    const mark = STRESS[t.type];
    if (mark && pendingStress === null) pendingStress = mark; // never stack
  }
  flushStress(); // trailing stress with no following vowel
  return out;
}

/** All IPA symbols a profile can emit, for validation against a voice. */
export function profileSymbols(profile: VoiceProfile = SV_PROFILE): Set<string> {
  const out = new Set<string>();
  for (const ipa of Object.values(profile.map)) {
    for (const ch of ipa) out.add(ch);
  }
  return out;
}
