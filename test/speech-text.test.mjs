import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript, prepareSpeech } from "../dist/speech-text.js";

test("plain speech passes through untouched, with no note", () => {
  const r = prepareSpeech("The build passed and all 42 tests are green. Want me to open the PR?");
  assert.equal(r.text, "The build passed and all 42 tests are green. Want me to open the PR?");
  assert.deepEqual(r.notes, []);
});

test("markdown, code, paths, URLs and emoji are rewritten for the ear", () => {
  const r = prepareSpeech(
    "## Results\n- `npm test` ✅ 42/42\n- **Coverage**: 91%\n- see /Users/jeet/repo/src/index.ts:120 and https://github.com/jeet/repo/pull/7.\n\n```ts\nconst x = await foo();\n```\nShould I merge -> main?",
  );
  assert.equal(
    r.text,
    "Results. npm test 42 of 42. Coverage: 91%. see index.ts and a link to github.com. (I've left the code on screen.) Should I merge to main?",
  );
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /code blocks, URLs, file paths/);
});

test("tables and symbol-heavy inline code are replaced; dates and and/or survive", () => {
  const r = prepareSpeech("| a | b |\n|---|---|\n| 1 | 2 |\nDeadline is 9/23/2026 and/or later. Check src/lib/auth/session.ts & `user_id`. Call `retry(fn, {tries: 3})`.");
  assert.equal(r.text, "(There's a table on screen.) Deadline is 9/23/2026 and/or later. Check session.ts and user id. Call that code.");
});

test("long text is cut at a sentence boundary", () => {
  const long = Array(30).fill("This is a fairly long sentence about the refactor.").join(" ");
  const r = prepareSpeech(long, { maxWords: 40 });
  assert.ok(r.text.endsWith("refactor. The rest is on screen."));
  assert.ok(r.text.split(" ").length <= 45);
  assert.match(r.notes[0], /over 40 words/);
});

test("cleanTranscript drops whisper markers and timestamps", () => {
  assert.equal(cleanTranscript(" Yes, go ahead.\n [BLANK_AUDIO]\n"), "Yes, go ahead.");
  assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Deploy it.\n"), "Deploy it.");
  assert.equal(cleanTranscript("[ Silence ]"), "");
});
