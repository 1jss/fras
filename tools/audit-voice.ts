#!/usr/bin/env node
/**
 * Audit the voice-facing IPA against a Piper voice's symbol table.
 *
 * fras only ever emits symbols the Swedish voices were trained on. This tool
 * checks that every symbol the active profile can produce exists in a voice's
 * `phoneme_id_map`, so nothing is silently dropped at synthesis time.
 *
 * Usage:
 *   node tools/audit-voice.ts --voice /path/to/sv_SE-alma-medium.onnx
 *   node tools/audit-voice.ts            # just print the profile's symbols
 *
 * The dynamic half of the audit (confirming a symbol is *voiced*, not just
 * present in the map) needs Piper; see docs/validation.md.
 */

import { readFileSync } from "node:fs";
import { profileSymbols, SV_PROFILE } from "../src/to-voice-ipa.ts";

function parseArgs(argv: string[]) {
  const args: { voice?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--voice") {
      const value = argv[++i];
      if (value !== undefined) args.voice = value;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const symbols = profileSymbols(SV_PROFILE);
  const stress = new Set(["ˈ", "ˌ"]);
  const all = new Set([...symbols, ...stress]);

  process.stdout.write(
    `profile "${SV_PROFILE.name}": ${all.size} distinct symbols\n  ${[...all].sort().join(" ")}\n`,
  );

  if (!args.voice) {
    process.stdout.write("\n(no --voice given; skipping phoneme_id_map check)\n");
    return;
  }

  const configPath = args.voice.endsWith(".json") ? args.voice : `${args.voice}.json`;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    phoneme_id_map?: Record<string, unknown>;
  };
  const map = config.phoneme_id_map ?? {};
  const missing = [...all].filter((s) => !(s in map));
  if (missing.length === 0) {
    process.stdout.write(`\nOK: all ${all.size} symbols are in ${configPath}\n`);
  } else {
    process.stdout.write(
      `\nMISSING from ${configPath} (${missing.length}): ${missing.join(" ")}\n`,
    );
    process.exitCode = 1;
  }
}

main();
