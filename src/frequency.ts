/**
 * Word-frequency interface and usage-prune policy.
 *
 * The per-word rate used for pruning comes from the POS-conditioned table
 * (`src/pos-frequency.ts`, built by `tools/build-pos-frequency.ts` from
 * Språkbanken's *Corpus word statistics*); `tools/frequency-report.ts` prints the
 * dropoff distribution and `tools/prune-lexicon.ts` uses it to cut the long tail.
 * Nothing here is needed at phonetization time.
 */

export interface FrequencyTable {
  /** Usage frequency (per million); 0 when absent. */
  frequency(word: string): number;
  /** Words in the table. */
  readonly size: number;
  /** Sum of the table's frequencies (token mass of the retained words). */
  readonly mass: number;
  /** Raw entries, for reporting. */
  entries(): IterableIterator<[string, number]>;
}

/** Six significant digits keep the committed table small without loss of meaning. */
export function formatFrequency(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * A "full word": a string the tokenizer emits as a single word token.
 *
 * `src/tokenize.ts` splits on every non-letter, so hyphenated, underscore-joined,
 * affix (`x-`, `-x`) and digit-bearing entries can never be reached from text.
 * Any Unicode letter is accepted, so accented loanwords (`abbé`, `filé`) — which
 * the tokenizer *does* reach — are kept.
 */
const FULL_WORD_RE = /^[\p{L}\p{M}]+$/u;

export function isFullWord(word: string): boolean {
  return FULL_WORD_RE.test(word);
}

export interface PrunePolicy {
  /** Drop stored rows below this usage frequency (per million); 0 disables. */
  minFreq: number;
  /** Drop rows the tokenizer can never reach (see {@link isFullWord}). */
  fullWordsOnly: boolean;
}

export type PruneDecision = "keep" | "non-word" | "low-freq";

/**
 * Whether a non-rule-covered lexicon row should stay in the production lexicon.
 *
 * Rule-covered words are routed to the rule index before this is consulted, so a
 * "drop" here means the word falls through to morphology/generic rules and its
 * pronunciation may diverge from NST.
 */
export function pruneDecision(
  word: string,
  freq: FrequencyTable | null,
  policy: PrunePolicy,
): PruneDecision {
  if (policy.fullWordsOnly && !isFullWord(word)) return "non-word";
  if (policy.minFreq > 0 && freq && freq.frequency(word) < policy.minFreq) return "low-freq";
  return "keep";
}
