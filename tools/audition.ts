#!/usr/bin/env node
/**
 * Interactive NST-vs-Braxen listening harness.
 *
 * The audit (`tools/audit-nst.ts`) tells us *where* NST and Braxen disagree once
 * both are rendered in the alphabet fras hands to Piper. This tool lets us hear
 * *what that sounds like*: it picks a few clean examples of a divergence bucket,
 * plays the NST rendering first and the Braxen rendering second through Piper,
 * and records which side you preferred. The per-bucket tally is the beginning
 * of a picture of which resource voices well with the current voice.
 *
 * Playback uses voxos's one-shot `say` tool (`tools/say.ts --raw "[[…]]"`), so a
 * Piper model load (~6 s) precedes each playback. The voice is whatever voxos is
 * configured with (`sv_SE-alma-medium` by default); change `TTS.voice` in
 * `voxos/src/config.ts` to audition another voice.
 *
 * Selection is deliberately narrow: a record joins a bucket only when the target
 * voice substitution is its *only* difference, and examples are drawn from the
 * top of the POS frequency table so the words are familiar.
 *
 * Usage:
 *   node tools/audition.ts [--pairs "ɛ→ə,ʊ→ɔ,…"] [--per-bucket N] [--top K]
 *                          [--voxos PATH] [--seed N] [--out PATH] [--stats-only]
 *
 * Keys at the prompt: 1 = NST, 2 = Braxen, r = replay both, a = NST only,
 * b = Braxen only, s = same/unsure, q = quit + summary.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { toVoiceIpa } from "../src/to-voice-ipa.ts";
import {
  alignSegments,
  braxenVoiceIpa,
  braxenVoiceSegments,
  nstVoiceSegments,
} from "../src/braxen.ts";
import { isFullWord, type FrequencyTable } from "../src/frequency.ts";
import { parsePosFrequency } from "../src/pos-frequency.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUDIT_PATH = join(ROOT, "data", "braxen-nst-audit.jsonl.gz");
const FREQ_PATH = join(ROOT, "data", "pos-frequency.tsv.gz");

/** The divergence buckets the audit surfaced as the top real differences. */
const DEFAULT_PAIRS = [
  "ɛ→ə",
  "ʊ→ɔ",
  "ɡ→∅",
  "k→∅",
  "ʂ→s",
  "∅→r",
  "rt→t",
  "d→∅",
];

type Choice = "nst" | "braxen" | "same";

interface AuditRecord {
  w: string;
  nst: string;
  braxen: string;
  pos: string;
  strict: number;
  voice: number;
  class: string;
  subs: Array<[string, string]>;
}

interface Candidate {
  rec: AuditRecord;
  freq: number;
}

interface Decision {
  w: string;
  bucket: string;
  nst: string;
  braxen: string;
  nst_payload: string;
  braxen_payload: string;
  choice: Choice;
  at: string;
}

interface Args {
  pairs: string[];
  perBucket: number;
  top: number;
  voxos: string;
  seed: number;
  out: string;
  statsOnly: boolean;
  stress: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pairs: DEFAULT_PAIRS,
    perBucket: 5,
    top: 100,
    voxos: process.env.VOXOS_DIR ?? join(ROOT, "..", "voxos"),
    seed: 1,
    out: join(ROOT, "data", "audition-log.jsonl"),
    statsOnly: false,
    stress: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pairs") args.pairs = parsePairs(argv[++i] ?? "");
    else if (a === "--per-bucket") args.perBucket = Number(argv[++i]);
    else if (a === "--top") args.top = Number(argv[++i]);
    else if (a === "--voxos") args.voxos = argv[++i] ?? args.voxos;
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--stats-only") args.statsOnly = true;
    else if (a === "--no-stress") args.stress = false;
    else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    }
  }
  return args;
}

function usage(): void {
  process.stdout.write(
    "usage: node tools/audition.ts [--pairs \"ɛ→ə,ʊ→ɔ,…\"] [--per-bucket N]\n" +
      "                              [--top K] [--voxos PATH] [--seed N]\n" +
      "                              [--out PATH] [--stats-only] [--no-stress]\n",
  );
}

/** Split a comma/space separated pair list, normalizing arrow spellings. */
function parsePairs(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((p) => p.replace(/(->|=>|⇒)/g, "→").trim())
    .filter(Boolean);
}

/** Deterministic PRNG (mulberry32) so `--seed` reproduces a session. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** The single voice substitution of a record, or null when it is not clean. */
function soleSubstitution(rec: AuditRecord): string | null {
  if (rec.voice !== 1) return null;
  const { subs } = alignSegments(
    nstVoiceSegments(rec.nst),
    braxenVoiceSegments(rec.braxen),
    (x, y) => x === y,
  );
  if (subs.length !== 1) return null;
  const [a, b] = subs[0]!;
  return `${a}→${b}`;
}

function loadAudit(pairs: string[]): {
  buckets: Map<string, Candidate[]>;
  counts: Map<string, number>;
} {
  const wanted = new Set(pairs);
  const buckets = new Map<string, Candidate[]>(pairs.map((p) => [p, []]));
  const counts = new Map<string, number>();
  const text = gunzipSync(readFileSync(AUDIT_PATH)).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as AuditRecord;
    if (rec.class !== "real") continue;
    const pair = soleSubstitution(rec);
    if (!pair) continue;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
    if (wanted.has(pair)) buckets.get(pair)!.push({ rec, freq: 0 });
  }
  return { buckets, counts };
}

/** Pick `n` clean, common examples for a bucket (top-K by usage frequency). */
function selectExamples(
  candidates: Candidate[],
  freq: FrequencyTable | null,
  perBucket: number,
  top: number,
  rng: () => number,
): Candidate[] {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.rec.w)) return false;
    seen.add(c.rec.w);
    return true;
  });

  let pool: Candidate[];
  if (freq) {
    const common = unique.filter((c) => isFullWord(c.rec.w) && freq.frequency(c.rec.w) > 0);
    if (common.length === 0) return [];
    common.sort((x, y) => freq.frequency(y.rec.w) - freq.frequency(x.rec.w));
    pool = common.slice(0, Math.max(top, perBucket));
  } else {
    pool = unique;
  }
  return shuffle([...pool], rng).slice(0, perBucket);
}

/** Locate voxos and confirm its one-shot `say` tool is present. */
function resolveVoxos(dir: string): string {
  if (!existsSync(join(dir, "tools", "say.ts"))) {
    throw new Error(
      `voxos say tool not found at ${join(dir, "tools", "say.ts")}; ` +
        `pass --voxos PATH or set VOXOS_DIR`,
    );
  }
  return dir;
}

/** Play one `[[…]]` payload through voxos's one-shot Piper `say`. */
function say(voxos: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(voxos, "tools", "say.ts"), "--raw", payload],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`voxos say exited with code ${code}`)),
    );
  });
}

function pct(x: number, n: number): string {
  return `${((100 * x) / Math.max(n, 1)).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(AUDIT_PATH)) {
    throw new Error(`audit not found at ${AUDIT_PATH}; run: npm run audit:nst`);
  }

  const freq: FrequencyTable | null = existsSync(FREQ_PATH)
    ? parsePosFrequency(readFileSync(FREQ_PATH))
    : null;
  if (!freq && !args.statsOnly) {
    process.stderr.write(
      `note: ${FREQ_PATH} missing, falling back to random examples (run: npm run frequency)\n`,
    );
  }

  const { buckets, counts } = loadAudit(args.pairs);

  const rng = mulberry32(args.seed);
  const plan = args.pairs.map((bucket) => ({
    bucket,
    clean: counts.get(bucket) ?? 0,
    picks: selectExamples(buckets.get(bucket) ?? [], freq, args.perBucket, args.top, rng),
  }));

  const totalClean = [...counts.values()].reduce((a, b) => a + b, 0);
  process.stdout.write(
    `NST vs Braxen audition\n` +
      plan
        .map(
          (p) =>
            `  ${p.bucket.padEnd(6)} ${String(p.clean).padStart(7)} clean records  → ` +
            `${p.picks.length} example(s)`,
        )
        .join("\n") +
      `\n  (${totalClean} clean single-substitution records total; ` +
      `per-bucket ${args.perBucket}, pool ${args.top}, seed ${args.seed})\n`,
  );

  if (args.statsOnly) {
    for (const p of plan) {
      for (const c of p.picks) {
        process.stdout.write(
          `${p.bucket}\t${c.rec.w}\tNST [[${toVoiceIpa(c.rec.nst, {
            stress: args.stress,
          })}]]\t` +
            `Braxen [[${braxenVoiceIpa(c.rec.braxen, { stress: args.stress })}]]\n`,
        );
      }
    }
    return;
  }

  const voxos = resolveVoxos(args.voxos);
  let rl: ReturnType<typeof createInterface> | null = null;
  let stdinClosed = false;
  let pendingAnswer: ((answer: string) => void) | null = null;
  let closeInput = (): void => {};
  // Created lazily and paused between answers so stdin is consumed one line at a
  // time, only while a prompt is open (Piper loading must not run ahead of it).
  const ask = (q: string): Promise<string> => {
    if (stdinClosed) return Promise.resolve("q");
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      closeInput = () => rl?.close();
      rl.on("close", () => {
        stdinClosed = true;
        pendingAnswer?.("q");
        pendingAnswer = null;
      });
    }
    return new Promise((res) => {
      pendingAnswer = res;
      rl!.resume();
      rl!.question(q, (answer) => {
        rl!.pause();
        pendingAnswer = null;
        res(answer);
      });
    });
  };
  const log = (s: string): void => {
    process.stdout.write(s);
  };

  const tally = new Map<string, { nst: number; braxen: number; same: number }>();
  for (const bucket of args.pairs) tally.set(bucket, { nst: 0, braxen: 0, same: 0 });

  let quit = false;
  for (const { bucket, picks } of plan) {
    if (quit) break;
    if (picks.length === 0) {
      log(`\n${bucket}: no examples (not enough clean, common records)\n`);
      continue;
    }
    for (let i = 0; i < picks.length && !quit; i += 1) {
      const { rec } = picks[i]!;
      const nstPayload = `[[${toVoiceIpa(rec.nst, { stress: args.stress })}]]`;
      const braxenPayload = `[[${braxenVoiceIpa(rec.braxen, { stress: args.stress })}]]`;

      const playNst = async (): Promise<void> => {
        try {
          await say(voxos, nstPayload);
        } catch (err) {
          log(`  ! ${err instanceof Error ? err.message : String(err)}\n`);
        }
      };
      const playBraxen = async (): Promise<void> => {
        try {
          await say(voxos, braxenPayload);
        } catch (err) {
          log(`  ! ${err instanceof Error ? err.message : String(err)}\n`);
        }
      };

      log(
        `\n[${bucket}  ${i + 1}/${picks.length}]  ${rec.w}  (${rec.pos})` +
          `  voice-dist ${rec.voice}\n` +
          `  1) NST     ${nstPayload}\n` +
          `  2) Braxen  ${braxenPayload}\n`,
      );
      await playNst();
      await playBraxen();

      let decision: Choice | null = null;
      while (!decision && !quit) {
        const ans = (
          await ask("  1=NST  2=Braxen  r=replay  a=NST  b=Braxen  s=same  q=quit > ")
        )
          .trim()
          .toLowerCase();
        switch (ans) {
          case "1":
            decision = "nst";
            break;
          case "2":
            decision = "braxen";
            break;
          case "s":
          case "=":
            decision = "same";
            break;
          case "r":
            await playNst();
            await playBraxen();
            break;
          case "a":
            await playNst();
            break;
          case "b":
            await playBraxen();
            break;
          case "q":
            quit = true;
            break;
          default:
            break;
        }
      }

      if (decision) {
        tally.get(bucket)![decision] += 1;
        const entry: Decision = {
          w: rec.w,
          bucket,
          nst: rec.nst,
          braxen: rec.braxen,
          nst_payload: nstPayload,
          braxen_payload: braxenPayload,
          choice: decision,
          at: new Date().toISOString(),
        };
        appendFileSync(args.out, `${JSON.stringify(entry)}\n`);
      }
    }
  }
  closeInput();

  const pad = (s: string): string => s.padStart(6);
  let nst = 0;
  let braxen = 0;
  let same = 0;
  const rows = args.pairs.map((bucket) => {
    const t = tally.get(bucket)!;
    nst += t.nst;
    braxen += t.braxen;
    same += t.same;
    return `  ${bucket.padEnd(6)} ${pad(String(t.nst))} ${pad(String(t.braxen))} ${pad(
      String(t.same),
    )}`;
  });
  const total = nst + braxen + same;
  process.stdout.write(
    `\npreference (NST vs Braxen):\n` +
      `  ${"bucket".padEnd(6)} ${pad("NST")} ${pad("Braxen")} ${pad("same")}\n` +
      rows.join("\n") +
      `\n  ${"total".padEnd(6)} ${pad(String(nst))} ${pad(String(braxen))} ${pad(
        String(same),
      )}` +
      `   (NST ${pct(nst, total)}, Braxen ${pct(braxen, total)}, same ${pct(same, total)})\n` +
      `\nlog: ${args.out}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
