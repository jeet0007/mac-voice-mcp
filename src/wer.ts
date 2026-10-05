/**
 * Word error rate: how far a transcript is from the words that were actually said.
 * Used by `doctor` and the round-trip tests, so "it heard me right" is a number, not a feeling.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0–999 as words ("42" → "forty two"), so "60" and "sixty" count as the same word. */
export function numberToWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : "");
  return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberToWords(n % 100)}` : "");
}

/** Lower-case words without punctuation; "index.ts" → "index ts", "60" → "sixty". */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ") // whisper's [BLANK_AUDIO], (music) …
    .replace(/(\d)[,.](?=\d{3}\b)/g, "$1") // 1,000 → 1000
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (/^\d{1,3}$/.test(w) ? numberToWords(Number(w)).split(" ") : [w]));
}

export interface WordScore {
  /** Word error rate: (substitutions + deletions + insertions) / reference words. 0 = perfect. */
  wer: number;
  errors: number;
  words: number;
}

/** Word-level edit distance between what was said (reference) and what was heard (hypothesis). */
export function wordErrorRate(reference: string, hypothesis: string): WordScore {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  const errors = prev[hyp.length]!;
  return { wer: ref.length ? errors / ref.length : hyp.length ? 1 : 0, errors, words: ref.length };
}
