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

/** Longest chunk handed to Kokoro at once, by weight (well under its ~510-token limit). */
export const MAX_CHUNK_CHARS = 250;
/**
 * Nothing plays until the first chunk is generated, so it's short: the first sentence, else its first
 * clauses, else its first words, up to this weight.
 */
export const FIRST_CHUNK_CHARS = 60;
/**
 * Each later chunk is generated while the one before it plays, so it may be at most this many times
 * longer. On an M-series Mac Kokoro makes speech about 2.8x faster than it plays (19 ms per character
 * for 59 ms of audio, plus ~290 ms per chunk), and trimming the edge silence leaves less to play.
 */
const GROWTH = 2;
/** A sentence or clause shorter than this rides with its neighbour: "not me." is never spoken alone. */
const MIN_PIECE_CHARS = 18;

const ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|No|Fig)\.$/;
const FUNCTION_WORDS = new Set(
  "and but so or that which because when while if then with to of for in on at as than before after until since where who whose whom".split(" "),
);

/** Digits and capitals are read out one by one, so they cost Kokoro about twice the tokens. */
const weight = (s: string) => s.length + (s.match(/[\p{N}\p{Lu}]/gu)?.length ?? 0);

const merged = (pieces: string[]) =>
  pieces.reduce<string[]>((out, p) => {
    if (out.length && (out[out.length - 1]!.length < MIN_PIECE_CHARS || p.length < MIN_PIECE_CHARS)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
    return out;
  }, []);

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
    const s = segment.trim();
    if (!s) continue;
    if (out.length && ABBREVIATION.test(out[out.length - 1]!)) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return merged(out);
}

/** Cut a clause between words within `limit`, preferring just before a function word past half-way. */
function wordCut(clause: string, limit: number): [string, string] {
  const words = clause.split(" ");
  if (weight(words[0]!) > limit) {
    // One word over the limit (a long URL or hash): cut inside it, or Kokoro truncates it.
    const chars = Array.from(words[0]!);
    let n = 0;
    for (let w = 0; n < chars.length - 1 && w + weight(chars[n]!) <= limit; n++) w += weight(chars[n]!);
    return [chars.slice(0, n).join(""), [chars.slice(n).join(""), ...words.slice(1)].join(" ")];
  }
  let len = -1;
  let fit = 1;
  let best = 0;
  for (let i = 0; i < words.length - 1; i++) {
    len += 1 + weight(words[i]!);
    if (len > limit) break;
    fit = i + 1;
    if (len >= limit / 2 && FUNCTION_WORDS.has(words[i + 1]!.toLowerCase().replace(/\W/g, ""))) best = i + 1;
  }
  const cut = best || fit;
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

/**
 * Split text into speakable chunks that grow: the first is short, so speech starts quickly, and each
 * later one is ready before the previous one has finished playing. Whole sentences, else whole
 * clauses (one over the growth budget is taken whole, as a pause at a bare space sounds broken);
 * only a clause over `maxChars`, or the first chunk, is cut between words. Nothing is lost or reordered.
 */
export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const clean = text
    .replace(/\s*\n+\s*/g, ". ") // Kokoro stops at a newline
    .replace(/([.!?:;,])\s*\.(?=\s|$)/g, "$1") // "Done:\n" → "Done:" not "Done:."
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) return []; // nothing to say (blank, or only punctuation)
  // Clause breaks need a space after them, so "1,000" and "12:30" stay whole.
  const units = sentences(clean).map((s) => merged(s.split(/(?<=[,;:—–])\s+/)));

  const chunks: string[] = [];
  while (units.length) {
    const first = chunks.length === 0;
    const budget = first ? FIRST_CHUNK_CHARS : Math.min(maxChars, Math.max(FIRST_CHUNK_CHARS, weight(chunks[chunks.length - 1]!) * GROWTH));
    let chunk = "";
    const fits = (t: string) => weight(chunk) + (chunk ? 1 : 0) + weight(t) <= budget;
    const add = (t: string) => (chunk = chunk ? `${chunk} ${t}` : t);
    for (;;) {
      const clauses = units[0]!;
      const sentence = clauses.join(" ");
      if (fits(sentence)) {
        add(sentence);
        units.shift();
        if (first || !units.length) break;
        continue;
      }
      while (clauses.length && fits(clauses[0]!)) add(clauses.shift()!);
      if (!chunk) {
        const [head, rest] = first || weight(clauses[0]!) > maxChars ? wordCut(clauses[0]!, budget) : [clauses[0]!, ""];
        add(head);
        if (rest) clauses[0] = rest;
        else clauses.shift();
      }
      if (!clauses.length) units.shift();
      break;
    }
    chunks.push(chunk);
  }
  return chunks;
}

/** The text Kokoro should speak, as chunks. */
export function prepareForKokoro(text: string): string[] {
  return chunkForSpeech(fixPronunciation(text));
}
