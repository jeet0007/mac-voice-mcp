/**
 * Text preparation for the Kokoro voice (pure, unit-tested).
 *
 * Kokoro reads text through espeak-ng, which trips over some developer jargon, silently stops at
 * newlines, and truncates anything past ~510 tokens. So before speaking we fix the known
 * mispronunciations and cut the text into sentence-sized chunks that can be generated one at a
 * time — the first chunk starts playing while the next is being generated.
 */

/** Words and patterns espeak gets wrong, with what to say instead. Applied in order. */
export const PRONUNCIATIONS: Array<[RegExp, string]> = [
  [/\bJSON\b/g, "jay-son"],
  [/\bYAML\b/g, "yammel"],
  [/\bSQLite\b/gi, "S Q lite"],
  [/\bRAM\b/g, "ram"],
  [/\bGIFs?\b/g, (m: string) => (m.endsWith("s") ? "gifs" : "gif")] as unknown as [RegExp, string],
  // file.ext → "file dot ext", spelling short extensions: index.ts → "index dot T S"
  [/\b([A-Za-z][\w-]*)\.(ts|js|tsx|jsx|py|rb|go|rs|md|sh|css|html|json|yml|yaml|toml)\b/g, "$1 dot $2"],
  // version numbers: 1.2.3 → "1 point 2 point 3" (espeak reads them as decimals)
  [/\bv?(\d+)\.(\d+)\.(\d+)\b/g, "$1 point $2 point $3"],
];

const SPELL_OUT = new Set(["ts", "js", "tsx", "jsx", "py", "rb", "rs", "md", "sh", "css", "yml"]);
const SAY_AS: Record<string, string> = { json: "jay-son", yaml: "yammel" };

export function fixPronunciation(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PRONUNCIATIONS) out = out.replace(pattern, replacement as string);
  // file extensions: spell the short ones letter by letter ("dot ts" → "dot T S")
  return out.replace(/\bdot (\w+)\b/g, (m, ext: string) => {
    const lower = ext.toLowerCase();
    if (SAY_AS[lower]) return `dot ${SAY_AS[lower]}`;
    return SPELL_OUT.has(lower) ? `dot ${ext.toUpperCase().split("").join(" ")}` : m;
  });
}

/** Longest chunk handed to Kokoro at once, in characters (well under its ~510-token limit). */
export const MAX_CHUNK_CHARS = 250;
/**
 * Nothing plays until the first chunk is generated, so it's short: the first sentence or clause of
 * at least FIRST_MIN_CHARS (so a lone "Okay." isn't all there is to play) and at most
 * FIRST_CLAUSE_CHARS; failing that, the first FIRST_CHUNK_CHARS, cut between words.
 */
export const FIRST_CHUNK_CHARS = 40;
const FIRST_MIN_CHARS = 15;
const FIRST_CLAUSE_CHARS = 60;
/**
 * Each later chunk is generated while the one before it plays, so it may be at most this many times
 * longer. On an M-series Mac Kokoro makes speech about 5x faster than it plays (13.5 ms per character
 * for 67 ms of audio, plus ~250 ms per chunk); 3x leaves room for a busy machine. Before, a short
 * opener followed by a long sentence ("Sure." then 150 characters) left 1.2 s of silence after it.
 */
const GROWTH = 3;

interface Word {
  w: string;
  /** The break after this word: 2 a sentence end, 1 a clause, 0 just a space. */
  rank: number;
}

/**
 * Split text into speakable chunks that grow: the first is short, so speech starts quickly, and each
 * later one is ready before the previous one has finished playing. Cuts at sentence ends, else at
 * clauses, else between words; nothing is lost or reordered.
 */
export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const clean = text
    .replace(/\s*\n+\s*/g, ". ") // Kokoro stops at a newline
    .replace(/([.!?:;,])\s*\.(?=\s|$)/g, "$1") // "Done:\n" → "Done:" not "Done:."
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) return []; // nothing to say (blank, or only punctuation)
  const words: Word[] = clean
    .split(" ")
    .map((w) => ({ w, rank: /[.!?]["')\]]*$/.test(w) ? 2 : /[,;:—–]$/.test(w) ? 1 : 0 }));

  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const first = chunks.length === 0;
    const limit = first ? FIRST_CLAUSE_CHARS : Math.min(maxChars, Math.max(FIRST_CHUNK_CHARS, chunks[chunks.length - 1]!.length * GROWTH));
    let len = 0;
    let end = i; // the words up to here fit
    let best = -1;
    let bestRank = -1;
    for (let j = i; j < words.length; j++) {
      const next = len === 0 ? words[j]!.w.length : len + 1 + words[j]!.w.length;
      if (len > 0 && next > limit) break;
      len = next;
      end = j + 1;
      const r = words[j]!.rank;
      // The first chunk takes the first break past its minimum; later ones the last, best break.
      if (first ? r > 0 && len >= FIRST_MIN_CHARS && best < 0 : r > 0 && r >= bestRank) {
        best = j + 1;
        bestRank = r;
      }
    }
    let cut: number;
    if (end >= words.length) cut = words.length; // the rest fits
    else if (best > i) cut = best;
    else if (first) {
      // No clause in reach: the first FIRST_CHUNK_CHARS, between words.
      cut = i;
      for (let n = 0; cut < end && (n === 0 || n + 1 + words[cut]!.w.length <= FIRST_CHUNK_CHARS); cut++) n += (n ? 1 : 0) + words[cut]!.w.length;
    } else cut = end; // only spaces to cut at: use the room
    chunks.push(words.slice(i, cut).map((x) => x.w).join(" "));
    i = cut;
  }
  return chunks;
}

/** The text Kokoro should speak, as chunks. */
export function prepareForKokoro(text: string): string[] {
  return chunkForSpeech(fixPronunciation(text));
}
