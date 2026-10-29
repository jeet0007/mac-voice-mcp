// Hang-up phrases: the whole transcript, with politeness around it, never a negation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHangUp } from "../dist/call.js";

test("hang-up phrases end the call; anything else, including 'don't hang up', doesn't", () => {
  for (const said of ["Hang up.", "hang up", "Okay, hang up now.", "Claude, hang up.", "Hang up, please.", "Bye Claude!", "Goodbye, Claude.", "End the call.", "End call", "Thanks, end the call now."]) {
    assert.equal(isHangUp(said), true, said);
  }
  for (const said of ["Don't hang up yet.", "Do not hang up.", "Should I hang up the picture?", "Bye.", "Hang on.", "Let's end the call after this test runs.", ""]) {
    assert.equal(isHangUp(said), false, said);
  }
});
