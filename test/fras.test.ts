import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { parseNst, syllabify as groupSyllables } from "../src/sampa.ts";
import { toVoiceIpa } from "../src/to-voice-ipa.ts";
import { applyRules, applyRulesTrace } from "../src/rules/engine.ts";
import { SV_RULES_COMPILED } from "../src/rules/sv-rules.ts";
import { syllabify } from "../src/syllable.ts";
import {
  fullLexicon,
  lexicon,
  nstBaseline,
  parseLexicon,
  parseRuleIndex,
  ruleIndex,
  PRUNED_LEXICON_PATH,
  RULE_INDEX_PATH,
  type Lexicon,
  type LexiconEntry,
  type RuleEntry,
} from "../src/lexicon.ts";
import {
  encodeCompactLexicon,
  encodeCompactRuleIndex,
  parseCompactLexicon,
  parseCompactRuleIndex,
} from "../src/compact.ts";
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
import {
  braxenSegments,
  braxenToIpa,
  braxenToNstSampa,
  braxenVoiceIpa,
  braxenVoiceSegments,
  classifySegments,
  matchClass,
  nstSegments,
  nstVoiceSegments,
  parseBraxen,
  parseBraxenBase,
} from "../src/braxen.ts";

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
  assert.equal(toVoiceIpa('"kOt`'), "kˈɔrt");
  assert.equal(toVoiceIpa('"bu:d`'), "bˈuːrd");
  assert.equal(toVoiceIpa('"x\\}:k'), "ʃˈʉːk");
  assert.equal(toVoiceIpa('""x\\U$t`a'), "ʃˈʊrta");
});

test("toVoiceIpa maps short ö to œ and g to script g", () => {
  assert.equal(toVoiceIpa('"m9t'), "mˈœt");
  assert.equal(toVoiceIpa('""gA:$ta'), "ɡˈɑːta");
});

test("toVoiceIpa collapses accent II to primary stress", () => {
  assert.equal(toVoiceIpa('""mE$nI$x\\a'), "mˈɛnɪʃa");
});

test("toVoiceIpa places stress before the nucleus, as espeak-ng does", () => {
  // The voices were trained on espeak output like `blˈandat`, `tˈɛŋkt`; a mark
  // before the onset consonants is voiced as an extra vowel.
  assert.equal(toVoiceIpa('""bland$dat'), "blˈanddat");
  assert.equal(toVoiceIpa('"tENkt'), "tˈɛŋkt");
  assert.equal(toVoiceIpa('"bi:$len'), "bˈiːlɛn");
  assert.equal(toVoiceIpa('e$kU$nU$"mi:'), "ɛkʊnʊmˈiː");
  // stress before an onset-free first syllable stays word-initial
  assert.equal(toVoiceIpa('"A:'), "ˈɑː");
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
  // The reduced vowel of a final `-eC` ending is schwa, as in Braxen
  // (`v"E:$g@n`, `b"u:$k@n`, `f""I$sk%@n`).
  assert.equal(applyRules("vägen", SV_RULES_COMPILED), "vE:g@n");
  assert.equal(applyRules("boken", SV_RULES_COMPILED), "bu:k@n");
  assert.equal(applyRules("fisken", SV_RULES_COMPILED), "fIsk@n");
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
  assert.equal(res.text, "[[hˈɛj]], [[dˈʉː]]!");
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
  const res = phonetizeWord("nåt", { lexicon: mockLexicon({ nåt: ['"nOt'] }) });
  assert.equal(res.source, "override");
  assert.equal(res.variants[0], '"no:t');
});

test("overrides: curated corrections win over the lexicon and rules", () => {
  // `nåt`: spoken long form (the lexicon has the short /nɔt/).
  assert.equal(textToIpa("nåt", { morphology: false }), "nˈoːt");
  // `några`: keeps the g (the lexicon drops it).
  assert.equal(textToIpa("några", { morphology: false }), "nˈoːɡra");
});

test("usage picks the everyday homograph reading", () => {
  // POS-conditioned frequency (`tools/build-braxen-lexicon.ts`) picks the verb
  // over the rare noun/khan spelling, so these no longer need overrides.
  const expected: Record<string, string> = {
    kan: "kˈan", // not the noun khan /kɑːn/
    drog: "drˈuːɡ", // preterite of dra, not the noun /droːɡ/
    bor: "bˈuːr", // present of bo, not the noun /boːr/
    läst: "lˈɛːst", // supine of läsa, not the noun /lɛst/
    skall: "skˈal", // the modal, not the noun /skɑːl/
  };
  for (const [word, ipa] of Object.entries(expected)) {
    assert.equal(textToIpa(word), ipa, word);
  }
});

test("full lexicon keeps one preferred variant for merged homographs", () => {
  const lex = fullLexicon();
  // The merged lexicon is Braxen-first, so the NST SAMPA spelling differs from
  // NST's own (stress sits before the nucleus); compare the voiced result.
  const expected: Record<string, string> = {
    han: "hˈan",
    hans: "hˈans",
    dig: "dˈɛj",
    sen: "sˈɛn",
    vi: "vˈiː",
    oss: "ˈɔs",
    du: "dˈʉː",
    hon: "hˈʊn",
    kan: "kˈan",
    men: "mˈɛn",
  };
  for (const [word, ipa] of Object.entries(expected)) {
    const entry = lex.lookup(word)!;
    assert.equal(entry.variants.length, 1, word);
    assert.equal(toVoiceIpa(entry.variants[0]!), ipa, word);
  }
});

test("merged lexicon keeps every NST full-word headword (no word lost)", () => {
  const merged = fullLexicon();
  const nst = nstBaseline();
  const missing: string[] = [];
  for (const w of nst.keys()) {
    if (isFullWord(w) && !merged.lookup(w)) missing.push(w);
  }
  assert.equal(missing.length, 0, `lost ${missing.length} e.g. ${missing.slice(0, 5).join(", ")}`);
});

test("textToIpa joins words and keeps punctuation", () => {
  const lex = mockLexicon({ hej: ['"hEj'] });
  assert.equal(textToIpa("Hej!", { lexicon: lex, morphology: false }), "hˈɛj!");
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

test("compact lexicon round-trips variants, segmentation and missing keys", () => {
  const entries: Array<[string, LexiconEntry]> = [
    ["cd", { variants: ['"se:d', '"sE:d'] }],
    ["ab", { variants: ['"A:b'], segmentation: "a+b" }],
    ["åäö", { variants: ['"o:'] }],
  ];
  const lex = parseCompactLexicon(gzipSync(encodeCompactLexicon(entries)));
  assert.equal(lex.size, 3);
  assert.deepEqual(lex.lookup("AB")!.variants, ['"A:b']);
  assert.equal(lex.lookup("ab")!.segmentation, "a+b");
  assert.equal(lex.lookup("cd")!.variants.length, 2);
  assert.deepEqual(lex.lookup("åäö")!.variants, ['"o:']);
  assert.equal(lex.lookup("nope"), null);
  // Keys are sorted by UTF-8 bytes (so `å` sorts after ASCII).
  assert.deepEqual([...lex.keys()], ["ab", "cd", "åäö"]);
});

test("compact rule index round-trips structure prefixes", () => {
  const entries: Array<[string, RuleEntry]> = [
    ["gata", { prefixes: [[2, '$"']] }],
    ["hej", { prefixes: [] }],
  ];
  const index = parseCompactRuleIndex(gzipSync(encodeCompactRuleIndex(entries)));
  assert.equal(index.size, 2);
  assert.deepEqual(index.lookup("GATA")!.prefixes, [[2, '$"']]);
  assert.deepEqual(index.lookup("hej")!.prefixes, []);
  assert.equal(index.lookup("nope"), null);
});

test("production compact lexicon matches the JSONL artifact", () => {
  const compact = lexicon();
  const source = parseLexicon(readFileSync(PRUNED_LEXICON_PATH));
  assert.equal(compact.size, source.size);
  let seen = 0;
  for (const w of source.keys()) {
    if (seen++ % 997 !== 0) continue;
    const a = source.lookup(w)!;
    const b = compact.lookup(w)!;
    assert.equal(b.variants[0], a.variants[0], w);
    assert.equal(b.segmentation, a.segmentation, w);
  }
});

test("production compact rule index matches the JSONL artifact", () => {
  const compact = ruleIndex();
  const source = parseRuleIndex(readFileSync(RULE_INDEX_PATH));
  assert.equal(compact.size, source.size);
  const lines = gunzipSync(readFileSync(RULE_INDEX_PATH)).toString("utf8").split("\n");
  let seen = 0;
  for (const line of lines) {
    if (!line || seen++ % 997 !== 0) continue;
    const rec = JSON.parse(line) as { w: string; prefixes: Array<[number, string]> };
    assert.deepEqual(compact.lookup(rec.w)!.prefixes, rec.prefixes, rec.w);
  }
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
  assert.equal(block, "[[hˈɛj!]]");
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

test("braxenSegments maps Base to IPA and drops stress/boundaries/r0", () => {
  assert.deepEqual(braxenSegments("b 'o . l"), ["b", "ɔ", "l"]);
  assert.deepEqual(braxenSegments("t w e n . t i ~ f 'o: r0"), [
    "t",
    "w",
    "e",
    "n",
    "t",
    "ɪ",
    "f",
    "oː",
  ]);
  assert.deepEqual(braxenSegments("g 'a: . t a"), ["ɡ", "ɑː", "t", "a"]);
});

test("parseBraxenBase peels stress marks", () => {
  assert.deepEqual(
    parseBraxenBase('"a n . t ,a: l').map((t) => [t.type, t.symbol]),
    [
      ["stress", '"'],
      ["phoneme", "a"],
      ["phoneme", "n"],
      ["boundary", "."],
      ["phoneme", "t"],
      ["stress", ","],
      ["phoneme", "a:"],
      ["phoneme", "l"],
    ],
  );
});

test("braxenToIpa concatenates and can render stress", () => {
  assert.equal(braxenToIpa("b 'o . l"), "bɔl");
  assert.equal(braxenToIpa("b 'o . l", { stress: true }), "bˈɔl");
});

test("braxenVoiceIpa renders stress and the voice alphabet", () => {
  // `ex` -> ə, `w` -> v, `e` -> ɛ, `r0` dropped; boundaries dropped.
  // Braxen writes the stress mark before the nucleus, like espeak-ng.
  assert.equal(braxenVoiceIpa('"a: - l ,a: . g a . r ex'), "ˈɑːlˌɑːɡarə");
  assert.equal(braxenVoiceIpa("b 'i: . l ex n"), "bˈiːlən");
  assert.equal(braxenVoiceIpa("t w e n . t i ~ f 'o: r0"), "tvɛntɪfˈoː");
  assert.equal(braxenVoiceIpa("b 'o . l", { stress: false }), "bɔl");
});

test("braxenToNstSampa maps Base to voice-equivalent NST SAMPA", () => {
  // Structure, stress and symbol mapping; `r0` is dropped.
  assert.equal(braxenToNstSampa("b 'i: . l ex n"), 'b"i:$l@n');
  assert.equal(braxenToNstSampa("k 'o rt"), 'k"Ot`');
  assert.equal(braxenToNstSampa("x 'uu: k"), 'x\\"}:k');
  assert.equal(braxenToNstSampa("'eu r"), '"E*Ur');
  assert.equal(braxenToNstSampa("t w e n . t i ~ f 'o: r0"), 'tven$tI_f"o:');
  // The whole point: the runtime rendering equals the auditioned Braxen one.
  const cases = [
    "b 'i: . l ex n",
    "k 'o rt",
    "x 'uu: k",
    'c "ae: . rl ,e: k',
    "s k 'o t",
    'g "a: . t ,a',
    "t w e n . t i ~ f 'o: r0",
    "'eu r",
    "d 'o m",
    "s p r \"i ng . ,a",
    "n \"o: . g ,o n",
  ];
  for (const base of cases) {
    assert.equal(toVoiceIpa(braxenToNstSampa(base)), braxenVoiceIpa(base), base);
  }
});

test("nstSegments uses the standard IPA map, not the voice profile", () => {
  assert.deepEqual(nstSegments('"kOt`'), ["k", "ɔ", "ʈ"]);
  assert.deepEqual(nstSegments("x\\}:k"), ["ɧ", "ʉː", "k"]);
  assert.deepEqual(nstSegments('"m9t'), ["m", "œ", "t"]);
});

test("voice segments convert both sides into the Piper alphabet", () => {
  assert.deepEqual(nstVoiceSegments('"kOt`'), ["k", "ɔ", "rt"]);
  assert.deepEqual(braxenVoiceSegments("k 'o rt"), ["k", "ɔ", "rt"]);
  // sje-sound: NST `x\` and Braxen `x` both become ʃ.
  assert.deepEqual(nstVoiceSegments("x\\}:k"), ["ʃ", "ʉː", "k"]);
  assert.deepEqual(braxenVoiceSegments("x 'uu: k"), ["ʃ", "ʉː", "k"]);
});

test("classifySegments classifies by Piper conversion", () => {
  // Different IPA (NST 9 = œ vs Braxen ö = ø) but the same Piper symbol.
  const rounded = classifySegments(
    nstSegments('"m9t'),
    braxenSegments("m 'ö t"),
    nstVoiceSegments('"m9t'),
    braxenVoiceSegments("m 'ö t"),
  );
  assert.equal(rounded.strict, 1);
  assert.equal(rounded.voice, 0);
  assert.equal(matchClass(rounded.strict, rounded.voice), "inventory");

  // Retroflex notation collapses to identical standard IPA -> match.
  const retro = classifySegments(
    nstSegments('"kOt`'),
    braxenSegments("k 'o rt"),
    nstVoiceSegments('"kOt`'),
    braxenVoiceSegments("k 'o rt"),
  );
  assert.equal(matchClass(retro.strict, retro.voice), "match");

  // NST `e` (Piper ɛ) vs Braxen `ex` (Piper ə): Piper output would differ.
  const schwa = classifySegments(["e"], ["ə"], ["ɛ"], ["ə"]);
  assert.equal(matchClass(schwa.strict, schwa.voice), "real");

  // The length mark is preserved by the voice alphabet, so length is real.
  const length = classifySegments(["e"], ["eː"], ["ɛ"], ["eː"]);
  assert.equal(matchClass(length.strict, length.voice), "real");
});

test("parseBraxen reads a gzipped JSONL sample", () => {
  const raw = `{"w":"bil","v":"b 'i: l","pos":"NN","lang":"swe"}\n`;
  const index = parseBraxen(gzipSync(Buffer.from(raw)));
  assert.equal(index.size, 1);
  const entries = index.get("bil")!;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.base, "b 'i: l");
  assert.equal(entries[0]!.pos, "NN");
});
