/** What a transcript is to a call. The shell reads the words here and hands the engine only the verdict. */
import type { Heard } from "./types.js";

/** About how fast the voices speak, to tell Claude how much of a reply was heard. */
const WORDS_PER_SECOND = 2.7;

const FILLERS = new Set(["mm", "mmm", "hmm", "mhm", "mm-hmm", "mm-hm", "uh-huh", "uh", "um", "ah", "oh", "okay", "ok", "yeah", "yep", "right", "sure"]);

/**
 * Only backchannel ("Mm-hmm.", "Yeah, okay.")? Then talking over Claude doesn't cut its reply.
 * Sound tags whisper adds ("[BLANK_AUDIO]", "(coughs)") don't count as words.
 */
function isFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.every((w) => FILLERS.has(w));
}

/**
 * Does the whole transcript mean "hang up"? Politeness and the name around it are fine
 * ("Okay, hang up now.", "Bye, Claude."); a negation is not ("Don't hang up yet.").
 */
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

/** The words of a reply the user heard in its first `playedMs`. */
export function heardSoFar(text: string, playedMs: number): string {
  // shortcut: estimated from the time played at an average pace, so off by a few words; upgrade when the voices report word timings.
  const words = text.split(/\s+/).filter(Boolean);
  const n = Math.max(1, Math.round((playedMs / 1000) * WORDS_PER_SECOND));
  return n >= words.length ? text : `${words.slice(0, n).join(" ")}…`;
}
