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

test("on-screen claim in spoken text appends a voice-mcp note", () => {
  const phrases = [
    "The diff is on screen, take a look.",
    "I've printed the results below.",
    "See the output above for details.",
    "The log is pasted in the reply.",
    "Look at the table I printed.",
  ];
  for (const phrase of phrases) {
    const r = prepareSpeech(phrase);
    const onScreenNote = r.notes.find((n) => n.includes("NOT visible"));
    assert.ok(onScreenNote, `Expected on-screen note for: "${phrase}"`);
  }
});

test("ordinary uses of above/below/see/printed don't trigger the on-screen note", () => {
  for (const phrase of [
    "It's above thirty degrees, and the build came in below budget.",
    "See the doctor if it still hurts tomorrow.",
    "The printed report is ready — want me to email it?",
    "Look at the time, should we stop here?",
  ]) {
    const r = prepareSpeech(phrase);
    assert.equal(r.notes.find((n) => n.includes("NOT visible")), undefined, `False positive for: "${phrase}"`);
  }
});

test("plain speech with no on-screen claims does not get the on-screen note", () => {
  const r = prepareSpeech("The build passed. Want me to open the pull request?");
  const onScreenNote = r.notes.find((n) => n.includes("NOT visible"));
  assert.equal(onScreenNote, undefined);
});

test("cleanTranscript drops whisper markers and timestamps", () => {
  assert.equal(cleanTranscript(" Yes, go ahead.\n [BLANK_AUDIO]\n"), "Yes, go ahead.");
  assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Deploy it.\n"), "Deploy it.");
  assert.equal(cleanTranscript("[ Silence ]"), "");
});

test("cleanTranscript drops whisper's sound notes: a cough or a fan is not an answer", () => {
  // Real whisper output for noise-only clips (a cough, typing, a fan, a hum, breathing).
  for (const note of ["[gunshot]", "[APPLAUSE]", "[sound of running]", "[MUSIC PLAYING]", "[Music]", "[static]", "(sound of running)", "*coughs*", "♪ ♪"]) {
    assert.equal(cleanTranscript(` ${note}\n`), "", note);
  }
  assert.equal(cleanTranscript("[laughs] Yes, ship it. (door closes)"), "Yes, ship it.");
});

test("cleanTranscript drops sentences whisper invents from videos, but never real answers", () => {
  assert.equal(cleanTranscript("You can find the link in the description below."), "");
  assert.equal(cleanTranscript("Merge it. Thank you for watching!"), "Merge it.");
  assert.equal(cleanTranscript("Please subscribe."), "");
  assert.equal(cleanTranscript("Subtitles by the Amara.org community"), "");
  // Real answers that look similar stay.
  assert.equal(cleanTranscript("Thank you."), "Thank you.");
  assert.equal(cleanTranscript("Bye."), "Bye.");
  assert.equal(cleanTranscript("Subscribe to the webhook events, then deploy."), "Subscribe to the webhook events, then deploy.");
  assert.equal(cleanTranscript("Put the link in the description of the PR."), "Put the link in the description of the PR.");
  assert.equal(cleanTranscript("Does version 1.2.3 work?"), "Does version 1.2.3 work?");
});

test("a one-word opener runs into the next sentence, so the voice doesn't stop after it", () => {
  assert.equal(prepareSpeech("Okay. This is what I found: the mock starts late.").text, "Okay, This is what I found: the mock starts late.");
  assert.equal(prepareSpeech("Got it! I'll run the tests first.").text, "Got it, I'll run the tests first.");
  assert.equal(prepareSpeech("Done. 42 tests pass.").text, "Done, 42 tests pass.");
  // Only at the very start, only known openers, and never on its own.
  assert.equal(prepareSpeech("Yes.").text, "Yes.");
  assert.equal(prepareSpeech("The build is done. Tests pass.").text, "The build is done. Tests pass.");
  assert.equal(prepareSpeech("Deploy. Then tell me.").text, "Deploy. Then tell me.");
});

test("cleanTranscript keeps ordinary words that start like a credit line, and reports what it drops", () => {
  assert.equal(cleanTranscript("I translated the file. Thanks."), "I translated the file. Thanks.");
  assert.equal(cleanTranscript("Translated the file. Thanks."), "Translated the file. Thanks.");
  assert.equal(cleanTranscript("Captions are wrong. Fix them."), "Captions are wrong. Fix them.");
  assert.equal(cleanTranscript("Transcription by CastingWords"), "");
  assert.equal(cleanTranscript("Transcription"), "");
  const dropped = [];
  assert.equal(cleanTranscript("Merge it. Thank you for watching!", dropped), "Merge it.");
  assert.deepEqual(dropped, ["Thank you for watching!"]);
  const lone = [];
  assert.equal(cleanTranscript("Transcription by CastingWords", lone), "");
  assert.deepEqual(lone, ["Transcription by CastingWords"]);
  assert.equal(cleanTranscript("Yes, go ahead.", lone), "Yes, go ahead.");
});

test("prepareSpeech tells Claude when it spoke only part of a long reply", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const r = prepareSpeech(long, { maxWords: 120, maxChars: 5000 });
  assert.ok(r.text.endsWith("The rest is on screen."));
  assert.match(r.notes.join("\n"), /only the first \d+ of 300 words were spoken/);
  const short = prepareSpeech("All done.", { maxWords: 120, maxChars: 5000 });
  assert.deepEqual(short.notes, []);
  const chars = prepareSpeech("word ".repeat(50), { maxWords: 0, maxChars: 40 });
  assert.match(chars.notes.join("\n"), /cut at 40 characters/);
});
