// Word error rate: the yardstick for doctor and the round-trip tests.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWords, numberToWords, wordErrorRate } from "../dist/wer.js";

test("normalizes punctuation, case, numbers and whisper's noise labels", () => {
  assert.deepEqual(normalizeWords("Ran `npm test` in index.ts — all 60 pass! [BLANK_AUDIO]"), ["ran", "npm", "test", "in", "index", "ts", "all", "sixty", "pass"]);
  assert.deepEqual(normalizeWords("It's 1,000"), ["its", "1000"]);
  assert.equal(numberToWords(342), "three hundred forty two");
});

test("counts substitutions, deletions and insertions per reference word", () => {
  assert.equal(wordErrorRate("the build passed", "The build passed.").wer, 0);
  assert.equal(wordErrorRate("the build passed", "the bild passed").errors, 1);
  assert.equal(wordErrorRate("the build passed", "the passed").errors, 1);
  assert.equal(wordErrorRate("the build passed", "so the build passed").errors, 1);
  assert.equal(wordErrorRate("open the pull request", "").wer, 1);
  assert.equal(wordErrorRate("", "").wer, 0);
});
