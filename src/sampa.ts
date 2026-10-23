/**
 * Canonical internal representation: NST SAMPA.
 *
 * The whole pipeline works in NST's own transcription alphabet (as found in
 * field 11 of `swe030224NST.pron`), because it is lossless: it keeps accent I
 * vs accent II, every variant, syllable boundaries (`$`), the compound marker
 * (`¤`) and intra-name word boundaries (`_`). Translation to the phoneme
 * alphabet a Piper voice was trained on happens only at the edge
 * (`to-voice-ipa.ts`).
 *
 * Symbol reference:
 *
 *   Vowels   i: I  e: e  E: E  y: Y  }: u0  u: U  o: O  2: 9  a A: @  a*U E*U
 *   Cons.    p b t d k g m n N f v r l s h j  t` d` n` l` s`  x\  s'
 *   Marks    $  syllable    "  accent I    ""  accent II    %  secondary stress
 *            ¤  compound     _  word boundary (inside names/compounds)
 */

/** Every NST phoneme symbol, longest first so greedy matching works. */
export const NST_PHONEMES = [
  "a*U",
  "E*U",
  "i:",
  "u0",
  "}:",
  "A:",
  "u:",
  "E:",
  "y:",
  "e:",
  "2:",
  "o:",
  "t`",
  "d`",
  "n`",
  "l`",
  "s`",
  "x\\",
  "s'",
  "I",
  "a",
  "U",
  "E",
  "Y",
  "e",
  "9",
  "O",
  "@",
  "p",
  "b",
  "t",
  "d",
  "k",
  "g",
  "m",
  "n",
  "N",
  "f",
  "v",
  "r",
  "l",
  "s",
  "h",
  "j",
] as const;

export type NstPhoneme = (typeof NST_PHONEMES)[number];

export type NstTokenType =
  | "phoneme"
  | "syllable"
  | "accent1"
  | "accent2"
  | "secondary"
  | "compound"
  | "word-boundary";

export interface NstToken {
  type: NstTokenType;
  /** The source symbol(s); equals the phoneme for `phoneme` tokens. */
  symbol: string;
}

export type Stress = "primary" | "secondary";

export interface NstSyllable {
  /** Stress carried by this syllable, if any. */
  stress: Stress | null;
  /** True when the stress is NST accent II (``""``). */
  accent2: boolean;
  phonemes: NstPhoneme[];
}

const VOWELS = new Set<NstPhoneme>([
  "i:",
  "I",
  "e:",
  "e",
  "E:",
  "E",
  "y:",
  "Y",
  "}:",
  "u0",
  "u:",
  "U",
  "o:",
  "O",
  "2:",
  "9",
  "a",
  "A:",
  "@",
  "a*U",
  "E*U",
]);

export function isVowel(p: NstPhoneme): boolean {
  return VOWELS.has(p);
}

function matchPhoneme(s: string, i: number): NstPhoneme | null {
  for (const p of NST_PHONEMES) {
    if (s.startsWith(p, i)) return p;
  }
  return null;
}

/**
 * Split an NST transcription into a flat token stream.
 *
 * Unknown characters are surfaced as `phoneme` tokens too, so nothing is
 * silently dropped; the adapter decides how to render or skip them.
 */
export function parseNst(s: string): NstToken[] {
  const tokens: NstToken[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('""', i)) {
      tokens.push({ type: "accent2", symbol: '""' });
      i += 2;
      continue;
    }
    const c = s[i]!;
    if (c === '"') {
      tokens.push({ type: "accent1", symbol: c });
      i += 1;
      continue;
    }
    if (c === "%") {
      tokens.push({ type: "secondary", symbol: c });
      i += 1;
      continue;
    }
    if (c === "$") {
      tokens.push({ type: "syllable", symbol: c });
      i += 1;
      continue;
    }
    if (c === "¤") {
      tokens.push({ type: "compound", symbol: c });
      i += 1;
      continue;
    }
    if (c === "_") {
      tokens.push({ type: "word-boundary", symbol: c });
      i += 1;
      continue;
    }
    const p = matchPhoneme(s, i);
    if (p) {
      tokens.push({ type: "phoneme", symbol: p });
      i += p.length;
      continue;
    }
    tokens.push({ type: "phoneme", symbol: c });
    i += 1;
  }
  return tokens;
}

/** Group a token stream into syllables, attaching stress to the next syllable. */
export function syllabify(tokens: NstToken[]): NstSyllable[] {
  const syllables: NstSyllable[] = [];
  let current: NstSyllable | null = null;
  let pendingStress: Stress | null = null;
  let pendingAccent2 = false;

  const start = (): NstSyllable => ({ stress: null, accent2: false, phonemes: [] });

  for (const t of tokens) {
    switch (t.type) {
      case "accent1":
        pendingStress = "primary";
        pendingAccent2 = false;
        break;
      case "accent2":
        pendingStress = "primary";
        pendingAccent2 = true;
        break;
      case "secondary":
        pendingStress = "secondary";
        break;
      case "syllable":
        current = null;
        break;
      case "compound":
      case "word-boundary":
        current = null;
        break;
      case "phoneme": {
        if (!current) {
          current = start();
          if (pendingStress) {
            current.stress = pendingStress;
            current.accent2 = pendingAccent2;
            pendingStress = null;
            pendingAccent2 = false;
          }
          syllables.push(current);
        }
        current.phonemes.push(t.symbol as NstPhoneme);
        break;
      }
      default:
        break;
    }
  }
  return syllables;
}

/** Number of vowel nuclei (syllable-ish count) in a token stream. */
export function nucleusCount(tokens: NstToken[]): number {
  let count = 0;
  let inVowel = false;
  for (const t of tokens) {
    if (t.type !== "phoneme") continue;
    const v = isVowel(t.symbol as NstPhoneme);
    if (v && !inVowel) count += 1;
    inVowel = v;
  }
  return count;
}
