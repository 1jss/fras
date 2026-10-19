#!/usr/bin/env node
/**
 * fras CLI.
 *
 *   fras "Hej på dig"          # IPA (voice alphabet)
 *   fras ipa "Hej på dig"      # same
 *   fras annotate "Hej på dig" # [[ …IPA… ]] blocks for Piper (per word)
 *   fras piper "Hej 12!"       # one [[ …IPA… ]] block for Piper (numbers spelled)
 *   fras word kärlek bilen     # per-word detail + provenance
 *   fras lexicon kärlek        # raw lexicon entry
 */

import { annotate } from "./annotate.ts";
import { fullLexicon } from "./lexicon.ts";
import { phonetizeWord, textToIpa } from "./phonetize.ts";
import { piperBlocks } from "./piper.ts";
import { toVoiceIpa } from "./to-voice-ipa.ts";

function usage(): void {
  process.stderr.write(
    'usage: fras [ipa|annotate|piper|word|lexicon] "text"\n',
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (command === "annotate") {
    const input = rest.join(" ").trim();
    const result = annotate(input);
    process.stdout.write(`${result.text}\n`);
    process.stderr.write(`hits ${result.hits}, misses ${result.misses}\n`);
    return;
  }

  if (command === "piper") {
    const input = rest.join(" ").trim();
    process.stdout.write(`${piperBlocks(input)}\n`);
    return;
  }

  if (command === "word") {
    for (const word of rest) {
      const res = phonetizeWord(word);
      const ipa = res.variants[0] ? toVoiceIpa(res.variants[0]) : "";
      process.stdout.write(
        `${word}\t[${res.source}${res.via ? " " + res.via : ""}]\t` +
          `${res.variants.join(" | ")}\t${ipa}\n`,
      );
    }
    return;
  }

  if (command === "lexicon") {
    const lex = fullLexicon();
    for (const word of rest) {
      const entry = lex.lookup(word);
      process.stdout.write(`${word}\t${entry ? entry.variants.join(" | ") : "(not found)"}\n`);
    }
    return;
  }

  // `ipa` or default: treat the whole argument list as text.
  const input = (command === "ipa" ? rest : argv).join(" ").trim();
  if (!input) {
    usage();
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${textToIpa(input)}\n`);
}

main();
