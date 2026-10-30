// Hang-up phrases: the whole transcript, with politeness around it, never a negation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { headphonesFromProfile } from "../dist/audio.js";
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
