// Picking the most natural installed macOS voice from `say -v '?'` output.
import assert from "node:assert/strict";
import test from "node:test";
import { parseSayVoices, pickVoice } from "../dist/audio.js";

const SAY_OUTPUT = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Ava (Premium)       en_US    # Hello! My name is Ava.",
  "Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.",
  "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
  "Kanya (Enhanced)    th_TH    # สวัสดีค่ะ",
  "Samantha            en_US    # Hello! My name is Samantha.",
  "Serena (Premium)    en_GB    # Hello! My name is Serena.",
  "Zoe (Premium)       en_US    # Hello! My name is Zoe.",
  "",
].join("\n");

test("parses names with spaces and parentheses, locales and quality", () => {
  const voices = parseSayVoices(SAY_OUTPUT);
  assert.equal(voices.length, 8);
  assert.deepEqual(voices.find((v) => v.name === "Eddy (English (UK))"), { name: "Eddy (English (UK))", locale: "en_GB", quality: 1 });
  assert.equal(voices.find((v) => v.name === "Ava (Premium)").quality, 3);
  assert.equal(voices.find((v) => v.name === "Daniel (Enhanced)").quality, 2);
});

test("prefers Premium, then the system's region, then name order", () => {
  const voices = parseSayVoices(SAY_OUTPUT);
  assert.equal(pickVoice(voices, "en", "en-US").name, "Ava (Premium)");
  assert.equal(pickVoice(voices, "en", "en-GB").name, "Serena (Premium)");
  assert.equal(pickVoice(voices, "auto", "en-TH").name, "Ava (Premium)");
});

test("matches the spoken language, and follows the system language for auto", () => {
  const voices = parseSayVoices(SAY_OUTPUT);
  assert.equal(pickVoice(voices, "th", "en-US").name, "Kanya (Enhanced)");
  assert.equal(pickVoice(voices, "auto", "th-TH").name, "Kanya (Enhanced)");
});

test("returns null when only standard voices are installed (keep the system voice)", () => {
  const voices = parseSayVoices("Albert  en_US  # Hi\nSamantha  en_US  # Hi\n");
  assert.equal(pickVoice(voices, "en", "en-US"), null);
  assert.equal(pickVoice(parseSayVoices(SAY_OUTPUT), "de", "de-DE"), null);
});
