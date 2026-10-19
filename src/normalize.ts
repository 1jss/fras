/**
 * Text normalization for the phonetic front-end: spell out numbers and expand a
 * few common abbreviations, so that no digit ever reaches the phonetizer.
 *
 * Piper's bundled espeak-ng used to do this for us; now that fras phonetizes the
 * whole utterance, the text must be word-only before it is tokenized. The output
 * is plain Swedish words, which the lexicon/rules can pronounce.
 */

const ONES = [
  "noll", "ett", "två", "tre", "fyra", "fem", "sex", "sju", "åtta", "nio",
  "tio", "elva", "tolv", "tretton", "fjorton", "femton", "sexton", "sjutton",
  "arton", "nitton",
] as const;

const TENS = [
  "", "", "tjugo", "trettio", "fyrtio", "femtio", "sextio", "sjuttio", "åttio",
  "nittio",
] as const;

/** Scale words, highest first: `[value, singular, plural]`. */
const SCALES: ReadonlyArray<readonly [number, string, string]> = [
  [1_000_000_000, "miljard", "miljarder"],
  [1_000_000, "miljon", "miljoner"],
  [1_000, "tusen", "tusen"],
];

/** 1..99 as a single Swedish word (`21` -> "tjugoett"). */
function spellTens(v: number): string {
  if (v < 20) return ONES[v] ?? "";
  const tens = TENS[Math.floor(v / 10)] ?? "";
  const ones = v % 10;
  return ones ? tens + (ONES[ones] ?? "") : tens;
}

/** 1..999 as a single Swedish compound (`101` -> "etthundraett"). */
function spellGroup(v: number): string {
  const hundreds = Math.floor(v / 100);
  const rest = v % 100;
  let out = "";
  if (hundreds > 0) out += (hundreds === 1 ? "ett" : (ONES[hundreds] ?? "")) + "hundra";
  if (rest > 0) out += spellTens(rest);
  return out;
}

/**
 * Spell out a non-negative integer in Swedish.
 *
 * Thousands are attached (`46500` -> "fyrtiosextusen"), millions and up are
 * separate words (`1500000` -> "en miljon femhundratusen").
 */
export function spellNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${spellNumber(-n)}`;
  n = Math.trunc(n);
  if (n === 0) return "noll";
  if (n >= 1_000_000_000_000) {
    // Out of range: read the digits one by one rather than emit a raw number.
    return String(n)
      .split("")
      .map((d) => ONES[Number(d)] ?? "")
      .join(" ");
  }

  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) {
    groups.push(rest % 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i] ?? 0;
    if (group === 0) continue;
    if (i === 0) {
      parts.push(spellGroup(group));
    } else if (i === 1) {
      // Thousands are written as one word: "ettusen", "fyrtiosextusen".
      parts.push(group === 1 ? "ettusen" : spellGroup(group) + "tusen");
    } else {
      const scale = SCALES[SCALES.length - i];
      if (!scale) {
        parts.push(spellGroup(group));
      } else {
        const [, singular, plural] = scale;
        parts.push(group === 1 ? `en ${singular}` : `${spellGroup(group)} ${plural}`);
      }
    }
  }

  // Attach a trailing ones/tens group to the preceding thousand so that
  // "2003" reads as "tvåtusentre", not "tvåtusen tre".
  if (parts.length >= 2) {
    const last = parts[parts.length - 1] ?? "";
    const prev = parts[parts.length - 2] ?? "";
    if (!last.includes("hundra") && prev.endsWith("tusen")) {
      parts.splice(parts.length - 2, 2, prev + last);
    }
  }

  return parts.join(" ");
}

/** Common abbreviations, longest/most specific first. */
const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bt\.ex\./gi, "till exempel"],
  [/\bbl\.a\./gi, "bland annat"],
  [/\bdvs\./gi, "det vill säga"],
  [/\bosv\./gi, "och så vidare"],
  [/\betc\./gi, "et cetera"],
  [/%/g, " procent"],
];

function expandAbbreviations(text: string): string {
  let out = text;
  for (const [re, replacement] of ABBREVIATIONS) out = out.replace(re, replacement);
  return out;
}

const DECIMAL_RE = /(\d+),(\d+)/g;
/** Grouped integers, e.g. "46 500", "1 000 000", "1.000". */
const GROUPED_INT_RE = /\d{1,3}(?:[ \u00A0.]\d{3})+/g;
const INT_RE = /\d+/g;

/**
 * Spell out numbers and expand abbreviations, and clean invisible characters.
 *
 * Decimals use the Swedish comma (`3,5` -> "tre komma fem"); thousands may be
 * grouped with a space, non-breaking space or dot (`46 500`). Soft hyphens are
 * removed (they would otherwise split a word) and non-breaking spaces collapse.
 */
export function normalizeText(text: string): string {
  let out = text.replace(/\u00ad/g, "").replace(/\u00a0/g, " ");

  // Decimals before grouped/bare integers so "3,5" is not split into "3"/"5".
  out = out.replace(
    DECIMAL_RE,
    (_m, intPart: string, fraction: string) =>
      `${spellNumber(Number(intPart))} komma ` +
      [...fraction].map((d) => ONES[Number(d)] ?? "").join(" "),
  );
  out = out.replace(GROUPED_INT_RE, (m) =>
    spellNumber(Number(m.replace(/[ \u00A0.]/g, ""))),
  );
  out = out.replace(INT_RE, (m) => spellNumber(Number(m)));

  out = expandAbbreviations(out);
  return out.replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
}
