import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { parseNst, syllabify as groupSyllables } from "../src/sampa.ts";
import { toVoiceIpa } from "../src/to-voice-ipa.ts";
import { applyRules, applyRulesTrace } from "../src/rules/engine.ts";
import { SV_RULES_COMPILED } from "../src/rules/sv-rules.ts";
import { syllabify } from "../src/syllable.ts";
import {
  fullLexicon,
  parseLexicon,
  parseRuleIndex,
  type Lexicon,
  type LexiconEntry,
} from "../src/lexicon.ts";
import {
  isFullWord,
  parseFrequency,
  pruneDecision,
  serializeFrequency,
} from "../src/frequency.ts";
import { morphological } from "../src/morphology.ts";
import { annotate } from "../src/annotate.ts";
import { normalizeText, spellNumber } from "../src/normalize.ts";
import { piperBlocks, piperPhonemes } from "../src/piper.ts";
import {
  applyStructureCorrection,
  phonemeSequence,
  phonetizeWord,
  textToIpa,
} from "../src/phonetize.ts";

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

test("rules: unstressed vowels reduce and soft consonants stay hard", () => {
  assert.equal(applyRules("abbedissa", SV_RULES_COMPILED), "abedIsa");
  assert.equal(applyRules("vägen", SV_RULES_COMPILED), "vE:gen");
  assert.equal(applyRules("boken", SV_RULES_COMPILED), "bu:ken");
  assert.equal(applyRules("fisken", SV_RULES_COMPILED), "fIsken");
  assert.equal(applyRules("flickorna", SV_RULES_COMPILED), "flIkUn`a");
  assert.equal(applyRules("hästarna", SV_RULES_COMPILED), "hEstan`a");
});

test("rules: lj, gt and the -era paradigm", () => {
  assert.equal(applyRules("ljus", SV_RULES_COMPILED), "j}:s");
  assert.equal(applyRules("biljett", SV_RULES_COMPILED), "bIljet");
  assert.equal(applyRules("sagt", SV_RULES_COMPILED), "sakt");
  assert.equal(applyRules("studera", SV_RULES_COMPILED), "st}:de:ra");
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

test("overrides: han and dig use the spoken forms", () => {
  assert.equal(
    textToIpa("Han ska hjälpa dig", { lexicon: null, morphology: false }),
    "ˈhan ˈskɑː ˈjɛlpa ˈdɛj",
  );
});

test("full lexicon keeps one preferred variant for merged homographs", () => {
  const lex = fullLexicon();
  const expected: Record<string, string> = {
    han: '"han',
    hans: '"hans',
    dig: '"dEj',
    sen: '"se:n',
    vi: '"vi:',
    oss: '"Os',
    du: '"d}:',
    hon: '"hUn',
    kan: '"kan',
    men: '"mEn',
  };
  for (const [word, variant] of Object.entries(expected)) {
    assert.deepEqual(lex.lookup(word)!.variants, [variant], word);
  }
});

test("textToIpa joins words and keeps punctuation", () => {
  const lex = mockLexicon({ hej: ['"hEj'] });
  assert.equal(textToIpa("Hej!", { lexicon: lex, morphology: false }), "ˈhɛj!");
});

test("applyRulesTrace records the grapheme span behind each output", () => {
  const trace = applyRulesTrace("kemi", SV_RULES_COMPILED);
  assert.equal(trace.output, "s'e:mI");
  assert.deepEqual(
    trace.steps.map((s) => [s.grapheme, s.o]),
    [
      ["k", "s'"],
      ["e", "e:"],
      ["m", "m"],
      ["i", "I"],
    ],
  );
});

test("phonemeSequence drops stress and boundaries", () => {
  assert.equal(phonemeSequence('""gA:$ta'), "gA:ta");
  assert.equal(phonemeSequence("gA:$ta"), "gA:ta");
});

test("applyStructureCorrection re-renders with NST structure", () => {
  assert.equal(applyStructureCorrection("gA:$ta", [[2, '$"']]), 'gA:$"ta');
  assert.equal(applyStructureCorrection("gA:$ta", []), "gA:$ta");
});

test("parseRuleIndex reads gzipped rule-covered words", () => {
  const raw = '{"w":"gata","prefixes":[[2,"$\\""]]}\n{"w":"hej","prefixes":[]}\n';
  const index = parseRuleIndex(gzipSync(Buffer.from(raw)));
  assert.equal(index.size, 2);
  assert.deepEqual(index.lookup("GATA")!.prefixes, [[2, '$"']]);
  assert.deepEqual(index.lookup("hej")!.prefixes, []);
  assert.equal(index.lookup("nope"), null);
});

test("spellNumber renders Swedish cardinals", () => {
  assert.equal(spellNumber(0), "noll");
  assert.equal(spellNumber(21), "tjugoett");
  assert.equal(spellNumber(1001), "ettusenett");
  assert.equal(spellNumber(2003), "tvåtusentre");
  assert.equal(spellNumber(46500), "fyrtiosextusen femhundra");
  assert.equal(spellNumber(603550), "sexhundratretusen femhundrafemtio");
  assert.equal(spellNumber(1500000), "en miljon femhundratusen");
});

test("normalizeText spells numbers and expands abbreviations", () => {
  assert.equal(normalizeText("kapitel 1."), "kapitel ett.");
  assert.equal(normalizeText("46 500 man"), "fyrtiosextusen femhundra man");
  assert.equal(normalizeText("3,5"), "tre komma fem");
  assert.equal(normalizeText("t.ex. 12"), "till exempel tolv");
  assert.equal(normalizeText("50%"), "femtio procent");
});

test("piperBlocks wraps a fully phonetized utterance in one block", () => {
  const block = piperBlocks("Hej!");
  assert.equal(block, "[[ˈhɛj!]]");
});

test("piperPhonemes spells out numbers and drops unmapped punctuation", () => {
  const phonemes = piperPhonemes("”Kapitel 46 500!”");
  assert.ok(phonemes.startsWith("ka"), phonemes);
  assert.ok(!phonemes.includes("46500"), phonemes);
  assert.ok(!/\d/.test(phonemes), phonemes);
  assert.ok(!phonemes.includes("\u201d"), phonemes);
  assert.ok(phonemes.endsWith("!"), phonemes);
});

test("piperBlocks is empty when there is nothing speakable", () => {
  assert.equal(piperBlocks("”«»"), "");
});

test("frequency table round-trips through gzip", () => {
  const gz = serializeFrequency([
    ["katt", 12.5],
    ["hund", 0.25],
    ["ö", 0.00123456],
  ]);
  const table = parseFrequency(gz);
  assert.equal(table.size, 3);
  assert.equal(table.frequency("KATT"), 12.5);
  assert.equal(table.frequency("hund"), 0.25);
  // Six significant digits are preserved.
  assert.equal(table.frequency("ö").toPrecision(6), "0.00123456");
  assert.equal(table.frequency("saknas"), 0);
  assert.ok(Math.abs(table.mass - (12.5 + 0.25 + 0.00123456)) < 1e-9);
});

test("isFullWord accepts only strings the tokenizer emits as one word", () => {
  assert.equal(isFullWord("katt"), true);
  assert.equal(isFullWord("abbé"), true); // accented loanword
  assert.equal(isFullWord("a-kassa"), false); // hyphen splits
  assert.equal(isFullWord("a_capella"), false); // underscore splits
  assert.equal(isFullWord("aero-"), false); // NST prefix
  assert.equal(isFullWord("-del"), false); // NST suffix
  assert.equal(isFullWord("a4"), false); // digit splits
  assert.equal(isFullWord("&"), false);
});

test("pruneDecision drops non-words and the low-frequency tail", () => {
  const freq = parseFrequency(serializeFrequency([["katt", 12.5], ["sällsynt", 0.002]]));
  const policy = { minFreq: 0.01, fullWordsOnly: true };
  assert.equal(pruneDecision("katt", freq, policy), "keep");
  assert.equal(pruneDecision("sällsynt", freq, policy), "low-freq");
  assert.equal(pruneDecision("a-kassa", freq, policy), "non-word");
  // A non-word is dropped before the frequency check is consulted.
  assert.equal(pruneDecision("a-kassa", null, { minFreq: 1, fullWordsOnly: true }), "non-word");
  // Frequency pruning is off by default, so everything reachable is kept.
  assert.equal(pruneDecision("sällsynt", freq, { minFreq: 0, fullWordsOnly: false }), "keep");
});
