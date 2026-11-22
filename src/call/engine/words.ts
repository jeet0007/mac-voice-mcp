// What a transcript means to a call, as a verdict for the engine. See docs/specs/call-mode.md.
import type { Heard } from "./types.js";

const WORDS_PER_SECOND = 2.7;

const FILLERS = new Set(["mm", "mmm", "hmm", "mhm", "mm-hmm", "mm-hm", "uh-huh", "uh", "um", "ah", "oh", "okay", "ok", "yeah", "yep", "right", "sure"]);

function isFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    // whisper's sound tags ("[BLANK_AUDIO]", "(coughs)") aren't words
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.every((w) => FILLERS.has(w));
}

function isHangUp(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:don't|do not|not|never)\b/.test(t)) return false;
  const around = "(?:okay|ok|alright|all right|yes|yeah|so|um|uh|well|please|thanks|thank you|now|for now|let's|can you|could you|claude|and)";
  const core = "(?:hang up|hangup|end (?:the )?call|(?:good)?bye claude)";
  return new RegExp(`^(?:${around} )*${core}(?: ${around})*$`).test(t);
}

export function classify(transcript: string): Heard {
  if (isHangUp(transcript)) return "hang-up";
  if (!transcript) return "empty";
  return isFiller(transcript) ? "filler" : "words";
}

export function heardSoFar(text: string, playedMs: number): string {
  // shortcut: estimated from the time played at an average pace, so off by a few words; upgrade when the voices report word timings.
  const words = text.split(/\s+/).filter(Boolean);
  const n = Math.max(1, Math.round((playedMs / 1000) * WORDS_PER_SECOND));
  return n >= words.length ? text : `${words.slice(0, n).join(" ")}…`;
}

const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Our own reply let through by the echo canceller: two words or more of it, nothing else.
export function echoes(heard: string, reply: string): boolean {
  const words = squash(heard);
  return words.includes(" ") && ` ${squash(reply)} `.includes(` ${words} `);
}
