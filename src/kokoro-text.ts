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
 * The first chunk is kept short: nothing plays until it's generated, so its length is the delay
 * before the first sound. Later chunks are generated while earlier ones play.
 */
export const FIRST_CHUNK_CHARS = 100;
/** Short sentences are merged up to this size: very short inputs sound worse. */
const MERGE_UP_TO = 120;
/** The first chunk only absorbs the next sentence while it's this short (e.g. "Done."). */
const FIRST_MERGE_UP_TO = 30;

/** Cut one sentence into pieces of at most `limit` characters: at clause boundaries, else between words. */
function splitLong(sentence: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const clause of sentence.split(/(?<=[,;:—–])\s+/)) {
    for (const word of clause.split(" ")) {
      if (current && current.length + 1 + word.length > limit) {
        pieces.push(current);
        current = "";
      }
      current = current ? `${current} ${word}` : word;
    }
    if (current.length >= limit * 0.6) {
      pieces.push(current);
      current = "";
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Split text into speakable chunks: sentences, merged when short, split at commas/words when long.
 * The first chunk is short, so speech starts quickly.
 */
export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const clean = text
    .replace(/\s*\n+\s*/g, ". ") // Kokoro stops at a newline
    .replace(/([.!?:;,])\s*\.(?=\s|$)/g, "$1") // "Done:\n" → "Done:" not "Done:."
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) return []; // nothing to say (blank, or only punctuation)
  const sentences = clean.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];

  const pieces: string[] = [];
  for (const sentence of sentences) {
    const limit = pieces.length === 0 ? Math.min(FIRST_CHUNK_CHARS, maxChars) : maxChars;
    if (sentence.length <= limit) pieces.push(sentence);
    else pieces.push(...splitLong(sentence, limit));
  }

  // Merge neighbours while short, so tiny fragments don't get their own odd-sounding chunk.
  const chunks: string[] = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    const mergeUpTo = chunks.length === 1 ? FIRST_MERGE_UP_TO : MERGE_UP_TO;
    const limit = chunks.length === 1 ? FIRST_CHUNK_CHARS : maxChars;
    if (last !== undefined && last.length < mergeUpTo && last.length + 1 + p.length <= limit) chunks[chunks.length - 1] = `${last} ${p}`;
    else chunks.push(p);
  }
  return chunks;
}

/** The text Kokoro should speak, as chunks. */
export function prepareForKokoro(text: string): string[] {
  return chunkForSpeech(fixPronunciation(text));
}
