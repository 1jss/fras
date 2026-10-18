import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { parseNst, syllabify as groupSyllables } from "../src/sampa.ts";
import { toVoiceIpa } from "../src/to-voice-ipa.ts";
import { applyRules } from "../src/rules/engine.ts";
import { SV_RULES_COMPILED } from "../src/rules/sv-rules.ts";
import { syllabify } from "../src/syllable.ts";
import { parseLexicon, type Lexicon, type LexiconEntry } from "../src/lexicon.ts";
import { morphological } from "../src/morphology.ts";
import { annotate } from "../src/annotate.ts";
import { phonetizeWord, textToIpa } from "../src/phonetize.ts";

test("parseNst splits symbols, stress and boundaries", () => {
  const tokens = parseNst('""gA:$ta');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ["accent2", "phoneme", "phoneme", "syllable", "phoneme", "phoneme"],
  );
  assert.deepEqual(
    tokens.filter((t) => t.type === "phoneme").map((t) => t.symbol),
    ["g", "A:", "t", "a"],
  );
});

test("syllabify groups into stressed syllables", () => {
  const syl = groupSyllables(parseNst('""gA:$ta'));
  assert.equal(syl.length, 2);
  assert.equal(syl[0]!.stress, "primary");
  assert.equal(syl[0]!.accent2, true);
});

test("toVoiceIpa splits retroflexes and rewrites the sje-sound", () => {
  assert.equal(toVoiceIpa('"kOt`'), "ˈkɔrt");
  assert.equal(toVoiceIpa('"bu:d`'), "ˈbuːrd");
  assert.equal(toVoiceIpa('"x\\}:k'), "ˈʃʉːk");
  assert.equal(toVoiceIpa('""x\\U$t`a'), "ˈʃʊrta");
});

test("toVoiceIpa maps short ö to œ and g to script g", () => {
  assert.equal(toVoiceIpa('"m9t'), "ˈmœt");
  assert.equal(toVoiceIpa('""gA:$ta'), "ˈɡɑːta");
});

test("toVoiceIpa collapses accent II to primary stress", () => {
  assert.equal(toVoiceIpa('""mE$nI$x\\a'), "ˈmɛnɪʃa");
});

test("rules: soft k and sj digraphs", () => {
  assert.equal(applyRules("kemi", SV_RULES_COMPILED), "s'e:mI");
  assert.equal(applyRules("skön", SV_RULES_COMPILED), "x\\2:n");
  assert.equal(applyRules("sju", SV_RULES_COMPILED), "x\\}:");
});

test("rules: retroflex sources and vowel length", () => {
  assert.equal(applyRules("kort", SV_RULES_COMPILED), "kOt`");
  assert.equal(applyRules("matt", SV_RULES_COMPILED), "mat");
  assert.equal(applyRules("mat", SV_RULES_COMPILED), "mA:t");
});

test("syllabify inserts boundaries before onsets", () => {
  assert.equal(syllabify("gA:ta"), "gA:$ta");
  assert.equal(syllabify("mEnIx\\a"), "mE$nI$x\\a");
});

function mockLexicon(entries: Record<string, string[]>): Lexicon {
  const map = new Map<string, LexiconEntry>(
    Object.entries(entries).map(([w, v]) => [w, { variants: v }]),
  );
  return {
    lookup: (w) => map.get(w.toLowerCase()) ?? null,
    size: map.size,
    keys: () => map.keys(),
  };
}

test("morphology: suffix stripping", () => {
  const lex = mockLexicon({ bil: ['"bi:l'] });
  const res = morphological("bilen", lex);
  assert.ok(res);
  assert.match(res!.via, /^suffix:bil\+en$/);
  assert.equal(res!.variants[0], '"bi:l$en');
});

test("morphology: compound splitting", () => {
  const lex = mockLexicon({ bil: ['"bi:l'], vag: ['"vA:g'] });
  const res = morphological("bilvag", lex);
  assert.ok(res);
  assert.match(res!.via, /^compound:bil\+vag$/);
  assert.equal(res!.variants[0], '"bi:l$%vA:g');
});

test("morphology: returns null when nothing applies", () => {
  assert.equal(morphological("xyzzy", mockLexicon({})), null);
});

test("annotate wraps words and preserves punctuation", () => {
  const lex = mockLexicon({ hej: ['"hEj'] });
  const res = annotate("Hej, du!", { lexicon: lex, morphology: false });
  assert.equal(res.text, "[[ˈhɛj]], [[ˈdʉː]]!");
  assert.equal(res.hits, 2);
});

test("lexicon parses a gzipped JSONL buffer", () => {
  const raw = '{"w":"ab","v":["\\"A:b"]}\n{"w":"cd","v":["\\"se:d","\\"sE:d"]}\n';
  const lex = parseLexicon(gzipSync(Buffer.from(raw)));
  assert.equal(lex.size, 2);
  assert.deepEqual(lex.lookup("AB")!.variants, ['"A:b']);
  assert.equal(lex.lookup("cd")!.variants.length, 2);
  assert.equal(lex.lookup("nope"), null);
});

test("phonetizeWord uses overrides before the lexicon", () => {
  const res = phonetizeWord("det", { lexicon: mockLexicon({ det: ['"dEt'] }) });
  assert.equal(res.source, "override");
  assert.equal(res.variants[0], '"de:');
});

test("textToIpa joins words and keeps punctuation", () => {
  const lex = mockLexicon({ hej: ['"hEj'] });
  assert.equal(textToIpa("Hej!", { lexicon: lex, morphology: false }), "ˈhɛj!");
});
