// Pure text preparation for the Kokoro voice: pronunciation fixes and chunking. See docs/specs/speech-output.md.

export const PRONUNCIATIONS: Array<[RegExp, string]> = [
  [/\bJSON\b/g, "jay-son"],
  [/\bYAML\b/g, "yammel"],
  [/\bSQLite\b/gi, "S Q lite"],
  [/\bRAM\b/g, "ram"],
  [/\bGIFs?\b/g, (m: string) => (m.endsWith("s") ? "gifs" : "gif")] as unknown as [RegExp, string],
  [/\b([A-Za-z][\w-]*)\.(ts|js|tsx|jsx|py|rb|go|rs|md|sh|css|html|json|yml|yaml|toml)\b/g, "$1 dot $2"],
  [/\bv?(\d+)\.(\d+)\.(\d+)\b/g, "$1 point $2 point $3"],
];

const SPELL_OUT = new Set(["ts", "js", "tsx", "jsx", "py", "rb", "rs", "md", "sh", "css", "yml"]);
const SAY_AS: Record<string, string> = { json: "jay-son", yaml: "yammel" };

export function fixPronunciation(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PRONUNCIATIONS) out = out.replace(pattern, replacement as string);
  return out.replace(/\bdot (\w+)\b/g, (m, ext: string) => {
    const lower = ext.toLowerCase();
    if (SAY_AS[lower]) return `dot ${SAY_AS[lower]}`;
    return SPELL_OUT.has(lower) ? `dot ${ext.toUpperCase().split("").join(" ")}` : m;
  });
}

export const MAX_CHUNK_CHARS = 250;
export const FIRST_CHUNK_CHARS = 60;
const GROWTH = 2;
const MIN_PIECE_CHARS = 18;

const ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|No|Fig)\.$/;
const FUNCTION_WORDS = new Set(
  "and but so or that which because when while if then with to of for in on at as than before after until since where who whose whom".split(" "),
);

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

export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const clean = text
    .replace(/\s*\n+\s*/g, ". ") // Kokoro stops at a newline
    .replace(/([.!?:;,])\s*\.(?=\s|$)/g, "$1") // "Done:\n" → "Done:" not "Done:."
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) return [];
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

export function prepareForKokoro(text: string): string[] {
  return chunkForSpeech(fixPronunciation(text));
}
