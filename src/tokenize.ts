/**
 * Text tokenization: split into words (Unicode letters plus combining marks) and
 * everything else (spaces, punctuation). Only words are phonetized.
 */

export interface Token {
  kind: "word" | "other";
  text: string;
}

const WORD_RE = /[\p{L}\p{M}]+/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD_RE)) {
    const index = match.index;
    if (index > last) tokens.push({ kind: "other", text: text.slice(last, index) });
    tokens.push({ kind: "word", text: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "other", text: text.slice(last) });
  return tokens;
}
