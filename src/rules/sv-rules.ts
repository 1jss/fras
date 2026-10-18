/**
 * Swedish letter-to-sound rules (generic layer), emitting **NST SAMPA**.
 *
 * Seeded from espeak-ng's `dictsource/sv_rules` / `sv_list` but rewritten to
 * target NST's alphabet and to be corrected against the NST lexicon via
 * `npm run eval`. This is deliberately a headstart, not a finished rule set:
 * stress and many loan/irregular words are still handled by the lexicon.
 */

import { compileRules, type Rule } from "./engine.ts";

const CONS = "bcdfghjklmnpqrstvwxz";
const VOW = "aeiouyåäö";
/** Two or more consonant letters -> the preceding vowel is short. */
const SHORT_R = `^[${CONS}]{2,}`;

const LONG: Readonly<Record<string, string>> = {
  a: "A:",
  e: "e:",
  i: "i:",
  o: "u:",
  u: "}:",
  y: "y:",
  "å": "o:",
  "ä": "E:",
  "ö": "2:",
};

const SHORT: Readonly<Record<string, string>> = {
  a: "a",
  e: "E",
  i: "I",
  o: "O",
  u: "u0",
  y: "Y",
  "å": "O",
  "ä": "E",
  "ö": "9",
};

/**
 * Vowels in an unstressed final syllable. Swedish reduces these: `e` is a plain
 * short `e` (not `E`), and the plural `-or` is `U` (flickor -> flI$kUr).
 */
const FINAL: Readonly<Record<string, string>> = {
  a: "a",
  e: "e",
  i: "I",
  o: "U",
  u: "u0",
  y: "Y",
  "å": "O",
  "ä": "E",
  "ö": "9",
};

/** Build the vowel rules: specific contexts first, then short, then long. */
function vowelRules(): Rule[] {
  const rules: Rule[] = [];
  for (const v of Object.keys(LONG)) {
    // Special: a before -tion is short (station, nation, ...).
    if (v === "a") rules.push({ m: v, r: "^tion", o: "a" });
    // Last vowel of a multisyllabic word: unstressed final syllable (before the
    // cluster rule, because a reduced final vowel can still precede a cluster).
    rules.push({
      m: v,
      l: `.*[${VOW}].*`,
      r: `^[^${VOW}]*$`,
      o: FINAL[v]!,
      note: "unstressed final syllable",
    });
    rules.push({ m: v, r: SHORT_R, o: SHORT[v]!, note: "short before consonant cluster" });
    // Last vowel of a monosyllable stays long.
    rules.push({ m: v, r: `^[^${VOW}]*$`, o: LONG[v]!, note: "monosyllable" });
    rules.push({ m: v, o: LONG[v]!, note: "long elsewhere" });
  }
  return rules;
}

/**
 * Ordered rules. Longest grapheme match wins; for equal-length matches the
 * earlier rule wins, so context-specific rules precede generic ones.
 */
export const SV_RULES: readonly Rule[] = [
  // --- unstressed vowels ----------------------------------------------------
  // These rules assume primary stress on the first syllable: any later vowel is
  // unstressed, so it is short and `e` loses its [E] colour (e -> [e]).
  { m: "e", l: `.*[${VOW}].*`, o: "e", note: "unstressed e -> [e]" },
  { m: "i", l: `.*[${VOW}].*`, o: "I", note: "unstressed i" },
  { m: "a", l: `.*[${VOW}].*`, o: "a", note: "unstressed a" },
  // Unstressed prefixes be-/ge- (word-initial).
  { m: "e", l: "^b", o: "e", note: "be- prefix" },
  { m: "e", l: "^g", o: "e", note: "ge- prefix" },

  ...vowelRules(),

  // --- common endings (longer than a single grapheme, so they win) ---
  { m: "ades", r: "$", o: "a$des" },
  { m: "ade", r: "$", o: "a$de" },
  { m: "ande", r: "$", o: "an$de" },
  { m: "ende", r: "$", o: "En$de" },

  // Definite plural / genitive: linking vowel reduced, `r` retroflexed.
  { m: "ernas", o: "en`as" },
  { m: "erna", o: "en`a" },
  { m: "arnas", o: "an`as" },
  { m: "arna", o: "an`a" },
  { m: "ornas", o: "Un`as" },
  { m: "orna", o: "Un`a" },

  // -era verbs: stressed long e (studera, regering).
  { m: "eringens", o: "e:rINens" },
  { m: "eringarna", o: "e:rINan`a" },
  { m: "eringar", o: "e:rINar" },
  { m: "eringen", o: "e:rINen" },
  { m: "ering", o: "e:rIN" },
  { m: "erades", o: "e:ra$des" },
  { m: "erade", o: "e:ra$de" },
  { m: "erats", o: "e:rats" },
  { m: "erar", o: "e:rar" },
  { m: "eras", o: "e:ras" },
  { m: "erat", o: "e:rat" },
  { m: "era", o: "e:ra" },

  // Intervocalic g/k/sk stay hard: root-final before a suffix vowel (vägen,
  // boken, fisken). Softening only applies word-initially or after a consonant.
  { m: "g", l: `[${VOW}]`, r: `^[eiyäö]`, o: "g", note: "hard g between vowels" },
  { m: "k", l: `[${VOW}]`, r: `^[eiyäö]`, o: "k", note: "hard k between vowels" },
  { m: "sk", l: `[${VOW}]`, r: `^[eiyäö]`, o: "sk", note: "hard sk between vowels" },

  // --- sibilants / sje ---
  { m: "sch", o: "x\\" },
  { m: "skj", o: "x\\" },
  { m: "stj", o: "x\\" },
  { m: "sj", o: "x\\" },
  { m: "sk", r: `^[eiyäö]`, o: "x\\" },
  { m: "ch", o: "x\\" },
  { m: "tion", o: "x\\u:n" },
  { m: "sion", o: "x\\u:n" },

  // --- kj / tj ---
  { m: "kj", o: "s'" },
  { m: "tj", o: "s'" },

  // --- j sounds ---
  { m: "dj", o: "j" },
  { m: "hj", o: "j" },
  { m: "lj", l: "^", o: "j", note: "lj is [j] word-initially only" },
  { m: "gj", o: "j" },

  // --- g ---
  { m: "gn", l: "^", o: "gn", note: "word-initial gn" },
  { m: "gn", o: "Nn" },
  { m: "ng", o: "N" },
  { m: "g", r: `^[eiyäö]`, o: "j" },

  // --- k / c ---
  { m: "ck", o: "k" },
  { m: "k", r: `^[eiyäö]`, o: "s'" },
  { m: "c", r: `^[eiyäö]`, o: "s" },
  { m: "c", o: "k" },

  // --- n before velars ---
  { m: "nk", o: "Nk" },
  { m: "n", r: "^[kg]", o: "N" },

  // --- retroflex sources -> NST retroflex symbols ---
  { m: "rt", o: "t`" },
  { m: "rd", o: "d`" },
  { m: "rn", o: "n`" },
  { m: "rl", o: "l`" },
  { m: "rs", o: "s`" },
  // Also retroflex when the `r` was already consumed (geminate): abborr+träsk.
  { m: "t", l: "r", o: "t`" },
  { m: "d", l: "r", o: "d`" },
  { m: "l", l: "r", o: "l`" },
  { m: "s", l: "r", o: "s`" },

  // --- loan digraphs ---
  { m: "th", o: "t" },
  { m: "ph", o: "f" },
  { m: "gt", o: "kt", note: "g before t is [k] (-igt, sagt, lagt)" },

  // --- x / z / w / q ---
  { m: "x", o: "ks" },
  { m: "z", o: "s" },
  { m: "w", o: "v" },
  { m: "q", o: "k" },

  // --- geminates -> single consonant ---
  { m: "bb", o: "b" },
  { m: "dd", o: "d" },
  { m: "ff", o: "f" },
  { m: "gg", o: "g" },
  { m: "ll", o: "l" },
  { m: "mm", o: "m" },
  { m: "nn", o: "n" },
  { m: "pp", o: "p" },
  { m: "rr", o: "r" },
  { m: "ss", o: "s" },
  { m: "tt", o: "t" },

  // --- default single consonants ---
  { m: "b", o: "b" },
  { m: "d", o: "d" },
  { m: "f", o: "f" },
  { m: "g", o: "g" },
  { m: "h", o: "h" },
  { m: "j", o: "j" },
  { m: "k", o: "k" },
  { m: "l", o: "l" },
  { m: "m", o: "m" },
  { m: "n", o: "n" },
  { m: "p", o: "p" },
  { m: "r", o: "r" },
  { m: "s", o: "s" },
  { m: "t", o: "t" },
  { m: "v", o: "v" },
];

export const SV_RULES_COMPILED = compileRules(SV_RULES);
