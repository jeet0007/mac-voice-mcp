// Hang-up phrases: the whole transcript, with politeness around it, never a negation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BargeIn, isFiller } from "../dist/barge-in.js";
import { headphonesFromProfile } from "../dist/speakers.js";
import { isHangUp } from "../dist/call.js";

test("hang-up phrases end the call; anything else, including 'don't hang up', doesn't", () => {
  for (const said of ["Hang up.", "hang up", "Okay, hang up now.", "Claude, hang up.", "Hang up, please.", "Bye Claude!", "Goodbye, Claude.", "End the call.", "End call", "Thanks, end the call now."]) {
    assert.equal(isHangUp(said), true, said);
  }
  for (const said of ["Don't hang up yet.", "Do not hang up.", "Should I hang up the picture?", "Bye.", "Hang on.", "Let's end the call after this test runs.", ""]) {
    assert.equal(isHangUp(said), false, said);
  }
});

test("headphones: the built-in jack's or Bluetooth ones count; the Mac's speakers and a Bluetooth speaker don't", () => {
  const profile = (output) => ({
    SPAudioDataType: [{ _items: [{ _name: "MacBook Air Microphone", coreaudio_default_audio_input_device: "spaudio_yes" }, { coreaudio_default_audio_output_device: "spaudio_yes", ...output }] }],
  });
  const builtin = "coreaudio_device_type_builtin";
  const bluetooth = "coreaudio_device_type_bluetooth";
  assert.equal(headphonesFromProfile(profile({ _name: "MacBook Air Speakers", coreaudio_device_transport: builtin, coreaudio_output_source: "MacBook Air Speakers" })), false);
  assert.equal(headphonesFromProfile(profile({ _name: "External Headphones", coreaudio_device_transport: builtin, coreaudio_output_source: "External Headphones" })), true);
  assert.equal(headphonesFromProfile(profile({ _name: "Jeet's AirPods Pro", coreaudio_device_transport: bluetooth })), true);
  assert.equal(headphonesFromProfile(profile({ _name: "JBL Flip 5 Speaker", coreaudio_device_transport: bluetooth })), false);
  assert.equal(headphonesFromProfile({}), false);
  assert.equal(headphonesFromProfile(null), false);
});

test("talking over Claude with only fillers or sound tags doesn't cut its reply; any real word does", () => {
  for (const said of ["Mm-hmm.", "mm hmm okay", "Uh-huh.", "Yeah, right.", "Okay. Sure!", "[BLANK_AUDIO]", "(coughs)", "Hmm... yep", ""]) {
    assert.equal(isFiller(said), true, said);
  }
  for (const said of ["Wait.", "Okay, stop.", "Yeah, use the other file.", "No.", "Hmm, that's wrong.", "ใช่"]) {
    assert.equal(isFiller(said), false, said);
  }
});

/** A BargeIn on a fake clock, recording every pause and stop. */
function bargeIn() {
  const log = [];
  let t = 1000;
  const b = new BargeIn((paused) => log.push(paused ? "pause" : "resume"), () => t);
  b.play("One two three four five six.", () => log.push("stop"));
  return { b, log, wait: (ms) => (t += ms) };
}

test("talking over a reply with real words pauses it, then drops the rest and the replies queued behind it", () => {
  const { b, log, wait } = bargeIn();
  wait(1111); // about three words in
  b.speech(true);
  assert.deepEqual(log, ["pause"]);
  const from = b.utterance();
  b.speech(false);
  assert.deepEqual(log, ["pause"], "still paused while the words are transcribed");
  assert.equal(b.heard(from, "Wait, use the other file."), "(You interrupted Claude after: 'One two three…') Wait, use the other file.");
  b.done(from);
  assert.deepEqual(log, ["pause", "stop", "resume"]);
  assert.equal(b.dropped(1500), true);
  wait(10);
  assert.equal(b.dropped(2200), false);
});

test("a filler said over a reply resumes it at once and isn't handed to Claude", () => {
  const { b, log } = bargeIn();
  b.speech(true);
  const from = b.utterance();
  b.speech(false);
  assert.equal(b.heard(from, "Mm-hmm."), "");
  b.done(from);
  assert.deepEqual(log, ["pause", "resume"]);
});

test("no words within 2 s resumes the reply, but never while the user is still talking", () => {
  const { b, log, wait } = bargeIn();
  b.speech(true);
  wait(2500);
  b.settle();
  assert.deepEqual(log, ["pause"], "still talking");
  b.speech(false); // a blip the endpointer threw away: no utterance
  assert.deepEqual(log, ["pause", "resume"]);
});

test("speech while nothing plays changes nothing; the call ending never leaves speech paused", () => {
  const idle = new BargeIn(() => assert.fail("nothing to pause"));
  idle.speech(true);
  assert.equal(idle.heard(idle.utterance(), "Hello there."), "Hello there.");

  const { b, log } = bargeIn();
  b.speech(true);
  b.end();
  assert.deepEqual(log, ["pause", "stop", "resume"]);
});
