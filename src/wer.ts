// Word error rate between what was said and what whisper heard. See docs/specs/speech-to-text.md.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// 0 to 999 only.
export function numberToWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : "");
  return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberToWords(n % 100)}` : "");
}

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ") // whisper's [BLANK_AUDIO], (music) …
    .replace(/(\d)[,.](?=\d{3}\b)/g, "$1")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (/^\d{1,3}$/.test(w) ? numberToWords(Number(w)).split(" ") : [w]));
}

export interface WordScore {
  wer: number;
  errors: number;
  words: number;
}

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
