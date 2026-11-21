// Hang-up phrases: the whole transcript, with politeness around it, never a negation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, heardSoFar } from "../dist/call/engine/words.js";
import { headphonesFromProfile } from "../dist/audio/process.js";

test("hang-up phrases end the call; anything else, including 'don't hang up', doesn't", () => {
  for (const said of ["Hang up.", "hang up", "Okay, hang up now.", "Claude, hang up.", "Hang up, please.", "Bye Claude!", "Goodbye, Claude.", "End the call.", "End call", "Thanks, end the call now."]) {
    assert.equal(classify(said), "hang-up", said);
  }
  for (const said of ["Don't hang up yet.", "Do not hang up.", "Should I hang up the picture?", "Bye.", "Hang on.", "Let's end the call after this test runs."]) {
    assert.equal(classify(said), "words", said);
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

test("only fillers or sound tags is a filler, which doesn't cut Claude's reply; any real word is words; nothing is empty", () => {
  for (const said of ["Mm-hmm.", "mm hmm okay", "Uh-huh.", "Yeah, right.", "Okay. Sure!", "[BLANK_AUDIO]", "(coughs)", "Hmm... yep"]) {
    assert.equal(classify(said), "filler", said);
  }
  for (const said of ["Wait.", "Okay, stop.", "Yeah, use the other file.", "No.", "Hmm, that's wrong.", "ใช่"]) {
    assert.equal(classify(said), "words", said);
  }
  assert.equal(classify(""), "empty");
});

test("how much of a reply was heard is its first words at an average pace, and all of it once that covers it", () => {
  assert.equal(heardSoFar("One two three four five six.", 1111), "One two three…");
  assert.equal(heardSoFar("One two three four five six.", 0), "One…");
  assert.equal(heardSoFar("One two three four five six.", 2300), "One two three four five six.");
});
