#!/usr/bin/env node
/**
 * Rebuild the compact runtime artifacts from the JSON-lines ones.
 *
 * `prune:write` already emits both forms; this tool regenerates the compact
 * files in place (useful when iterating on the codec, or after editing the
 * JSON-lines artifacts by hand).
 *
 * Usage:
 *   node tools/build-compact.ts [--check]
 *
 * `--check` decodes what it just wrote and exits non-zero if any lookup
 * disagrees with the source artifact.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  parseLexicon,
  parseRuleIndex,
  PRUNED_LEXICON_PATH,
  RULE_INDEX_PATH,
  PRUNED_LEXICON_COMPACT_PATH,
  RULE_INDEX_COMPACT_PATH,
  type LexiconEntry,
  type RuleEntry,
} from "../src/lexicon.ts";
import {
  encodeCompactLexicon,
  encodeCompactRuleIndex,
  parseCompactLexicon,
  parseCompactRuleIndex,
} from "../src/compact.ts";

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

function readRuleEntries(path: string): Array<[string, RuleEntry]> {
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  const out: Array<[string, RuleEntry]> = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as { w: string; prefixes: Array<[number, string]> };
    out.push([rec.w, { prefixes: rec.prefixes }]);
  }
  return out;
}

function main(): void {
  const check = process.argv.includes("--check");
  if (!existsSync(PRUNED_LEXICON_PATH) || !existsSync(RULE_INDEX_PATH)) {
    throw new Error(
      `missing ${PRUNED_LEXICON_PATH} or ${RULE_INDEX_PATH}; run: npm run prune:write`,
    );
  }

  const pruned = parseLexicon(readFileSync(PRUNED_LEXICON_PATH));
  const prunedEntries: Array<[string, LexiconEntry]> = [];
  for (const w of pruned.keys()) prunedEntries.push([w, pruned.lookup(w)!]);
  const ruleEntries = readRuleEntries(RULE_INDEX_PATH);

  const prunedBuf = encodeCompactLexicon(prunedEntries);
  const ruleBuf = encodeCompactRuleIndex(ruleEntries);
  writeFileSync(PRUNED_LEXICON_COMPACT_PATH, gzipSync(prunedBuf, { level: 9 }));
  writeFileSync(RULE_INDEX_COMPACT_PATH, gzipSync(ruleBuf, { level: 9 }));

  process.stdout.write(
    `wrote ${PRUNED_LEXICON_COMPACT_PATH} (${prunedEntries.length} rows, ` +
      `raw ${kb(prunedBuf.length)}, gz ${kb(readFileSync(PRUNED_LEXICON_COMPACT_PATH).length)})\n` +
      `wrote ${RULE_INDEX_COMPACT_PATH} (${ruleEntries.length} rows, ` +
      `raw ${kb(ruleBuf.length)}, gz ${kb(readFileSync(RULE_INDEX_COMPACT_PATH).length)})\n`,
  );

  if (!check) return;

  let mismatches = 0;
  const decLex = parseCompactLexicon(readFileSync(PRUNED_LEXICON_COMPACT_PATH));
  if (decLex.size !== pruned.size) mismatches += 1;
  for (const w of pruned.keys()) {
    const a = pruned.lookup(w)!;
    const b = decLex.lookup(w);
    if (!b || a.variants[0] !== b.variants[0] || a.segmentation !== b.segmentation) {
      mismatches += 1;
      if (mismatches <= 5) process.stdout.write(`  lexicon mismatch: ${w}\n`);
    }
  }
  const decRules = parseCompactRuleIndex(readFileSync(RULE_INDEX_COMPACT_PATH));
  const srcRules = parseRuleIndex(readFileSync(RULE_INDEX_PATH));
  if (decRules.size !== srcRules.size) mismatches += 1;
  for (const [w, e] of ruleEntries) {
    const b = decRules.lookup(w);
    if (!b || JSON.stringify(b.prefixes) !== JSON.stringify(e.prefixes)) {
      mismatches += 1;
      if (mismatches <= 5) process.stdout.write(`  rule mismatch: ${w}\n`);
    }
  }
  if (mismatches) {
    process.stdout.write(`check FAILED: ${mismatches} mismatches\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `check OK: ${pruned.size} lexicon + ${ruleEntries.length} rule-index rows round-trip\n`,
    );
  }
}

main();
