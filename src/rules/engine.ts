/**
 * A tiny ordered, context-sensitive rewrite engine for grapheme-to-phoneme rules.
 *
 * Rules are data. At each position we pick the rule with the **longest** grapheme
 * match whose left/right context holds (ties broken by rule order), emit its NST
 * SAMPA output, and advance. This mirrors espeak-ng's rule model without
 * adopting its notation, so the rule set stays readable and easy to extend.
 *
 * Context strings are regular expressions: `l` must match a suffix of the text
 * before the match (anchored at end), `r` a prefix of the text after it (anchored
 * at start). `#` is available as an alias for "word boundary" via `\b`-like
 * patterns written with `^`/`$` on the sliced context.
 */

export interface Rule {
  /** Grapheme sequence to match (lowercased). */
  m: string;
  /** Left context regex (matched against the text before the match). */
  l?: string;
  /** Right context regex (matched against the text after the match). */
  r?: string;
  /** NST SAMPA output. */
  o: string;
  /** Optional note for maintainers. */
  note?: string;
}

export interface CompiledRule {
  m: string;
  l: RegExp | null;
  r: RegExp | null;
  o: string;
}

export function compileRules(rules: readonly Rule[]): CompiledRule[] {
  return rules.map((rule) => ({
    m: rule.m.toLowerCase(),
    l: rule.l ? new RegExp(rule.l + "$") : null,
    r: rule.r ? new RegExp("^" + rule.r) : null,
    o: rule.o,
  }));
}

function bestMatch(text: string, i: number, rules: CompiledRule[]): CompiledRule | null {
  let best: CompiledRule | null = null;
  let bestLen = 0;
  const left = text.slice(0, i);
  for (const rule of rules) {
    if (rule.m.length < bestLen) continue;
    if (!text.startsWith(rule.m, i)) continue;
    if (rule.l && !rule.l.test(left)) continue;
    const right = text.slice(i + rule.m.length);
    if (rule.r && !rule.r.test(right)) continue;
    if (rule.m.length > bestLen) {
      best = rule;
      bestLen = rule.m.length;
    }
  }
  return best;
}

/** One applied step: the grapheme span consumed and the NST SAMPA it produced. */
export interface RuleStep {
  /** Start index in the lowercased word. */
  start: number;
  /** The grapheme span that was matched (or the single unknown character). */
  grapheme: string;
  /** NST SAMPA emitted for this span. */
  o: string;
  /** The rule that fired, or `null` when the grapheme was unknown. */
  rule: CompiledRule | null;
}

export interface RuleTrace {
  /** The concatenated NST SAMPA output (same as {@link applyRules}). */
  output: string;
  steps: RuleStep[];
}

/**
 * Apply compiled rules to a word and record which grapheme span produced which
 * output. Used by tooling (rule-coverage/divergence reports); the hot path uses
 * {@link applyRules}.
 */
export function applyRulesTrace(word: string, rules: CompiledRule[]): RuleTrace {
  const text = word.toLowerCase();
  let out = "";
  let i = 0;
  const steps: RuleStep[] = [];
  while (i < text.length) {
    const rule = bestMatch(text, i, rules);
    if (rule) {
      steps.push({ start: i, grapheme: text.slice(i, i + rule.m.length), o: rule.o, rule });
      out += rule.o;
      i += rule.m.length;
      continue;
    }
    // Unknown grapheme: keep it as-is so nothing is silently lost.
    steps.push({ start: i, grapheme: text[i]!, o: text[i]!, rule: null });
    out += text[i]!;
    i += 1;
  }
  return { output: out, steps };
}

/** Apply compiled rules to a word, returning an NST SAMPA segment string. */
export function applyRules(word: string, rules: CompiledRule[]): string {
  return applyRulesTrace(word, rules).output;
}
