/**
 * Pure text helpers (no I/O, unit-tested):
 *   - prepareSpeech: turn "screen text" into "ear text" before it's spoken
 *   - cleanTranscript: strip whisper.cpp's non-speech markers from a transcript
 */

export interface PreparedSpeech {
  text: string;
  /** Feedback for the model when its input had to be rewritten for speech. */
  notes: string[];
}

export interface PrepareOptions {
  /** Cut at a sentence boundary beyond this many words (0 = no limit). */
  maxWords?: number;
  /** Hard cap on characters handed to the TTS engine. */
  maxChars?: number;
}

/**
 * Phrases that send the user to look at something. Deliberately specific: bare words like
 * "above", "below" or "see the" also occur in ordinary speech ("above thirty degrees",
 * "see the doctor") and must not trigger the reminder.
 */
const ON_SCREEN_PATTERN = new RegExp(
  [
    String.raw`\bon[\s-]?screen\b`,
    String.raw`\bI(?:['’]ve| have)\s+(?:printed|pasted|put|posted|listed|written|shown|added)\b`,
    String.raw`\b(?:printed|pasted|posted|listed|shown|written)\s+(?:it\s+|them\s+)?(?:below|above|here)\b`,
    String.raw`\b(?:see|check|look at|scroll to)\s+(?:the\s+)?(?:screen|chat|reply|message|details|output|table|diff|log)\b`,
    String.raw`\bin (?:the|my) (?:reply|message|chat)\b`,
  ].join("|"),
  "i",
);

/**
 * Safety net for speakability. The model is asked (tool description, server
 * instructions, voice_mode prompt) to send plain spoken sentences; this catches
 * whatever slips through so the user never hears "backtick backtick backtick"
 * or a 40-segment file path read aloud.
 */
export function prepareSpeech(input: string, opts: PrepareOptions = {}): PreparedSpeech {
  const maxWords = opts.maxWords ?? 120;
  const maxChars = opts.maxChars ?? 4000;
  const notes = new Set<string>();
  let s = input.replace(/\r\n?/g, "\n");

  // Fenced code blocks and markdown tables can't be spoken meaningfully.
  s = s.replace(/```[\s\S]*?(?:```|$)/g, () => {
    notes.add("code blocks");
    return "\n(I've left the code on screen.)\n";
  });
  s = s.replace(/(?:^[ \t]*\|.*\|[ \t]*$\n?){2,}/gm, () => {
    notes.add("tables");
    return "\n(There's a table on screen.)\n";
  });

  // Inline code: keep short, word-like snippets; drop long or symbol-heavy ones.
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    if (code.length <= 32 && !/[{}();=<>[\]$]/.test(code)) return code;
    notes.add("inline code");
    return "that code";
  });

  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/<\/?[a-z][^>]*>/gi, " "); // stray HTML tags

  // Bare URLs → "a link to github.com".
  s = s.replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*?(?=[.,;:!?)]*(?:\s|$))/g, (_m, host: string) => {
    notes.add("URLs");
    return `a link to ${host}`;
  });

  // Long file paths → just the file name.
  s = s.replace(/(?<![\w/:])(?:(?:~|\.{1,2})?(?:\/[\w@.+-]+){2,}|[\w@.+-]+(?:\/[\w@.+-]+){2,})\/?/g, (m) => {
    if (/^[\d/.-]+$/.test(m)) return m; // dates like 9/23/2026
    notes.add("file paths");
    const parts = m.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? m;
  });
  s = s
    .replace(/\b([\w-]+\.[a-z]{1,5}):\d+(?::\d+)?\b/gi, "$1") // index.ts:120 → index.ts
    .replace(/(?<![\d/])(\d+)\/(\d+)(?![\d/])/g, "$1 of $2"); // 42/42 → 42 of 42

  // Markdown structure → sentences. Headings and bullets become their own sentence.
  s = s
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")
        .replace(/^\s*[-*_]{3,}\s*$/, "")
        .trim(),
    )
    .filter(Boolean)
    .map((line) => (/[.!?:;,…)]$/.test(line) ? line : `${line}.`))
    .join(" ");

  s = s
    .replace(/(\*\*|__|\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2") // emphasis markers
    .replace(/\p{Extended_Pictographic}️?/gu, "") // emoji
    .replace(/\s*(?:->|=>|→)\s*/g, " to ")
    .replace(/\s&\s/g, " and ")
    .replace(/[*_#~|^\\]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\.+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  // Keep it listenable: cut at a sentence boundary once it gets long.
  const words = s.split(" ");
  if (maxWords > 0 && words.length > maxWords) {
    let cut = words.slice(0, maxWords).join(" ");
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    if (lastStop > cut.length * 0.4) cut = cut.slice(0, lastStop + 1);
    s = `${cut} The rest is on screen.`;
    notes.add(`length (over ${maxWords} words)`);
  }
  s = s.slice(0, maxChars);

  const noteList = notes.size
    ? [
        `voice-mcp note: text_to_speak was rewritten for speech (removed/shortened: ${[...notes].join(", ")}). ` +
          "Next time send only short, plain spoken sentences — keep code, paths, links and tables in your on-screen reply.",
      ]
    : [];

  // When the spoken text points the user at something to look at, remind the model that only
  // its own assistant message renders — not the speech, and not Bash/tool output (issue #3).
  // Checked on the original input, so the "The rest is on screen." added above doesn't count.
  if (ON_SCREEN_PATTERN.test(input)) {
    noteList.push(
      "voice-mcp reminder: you told the user to look at something. Spoken text and Bash/tool output are " +
        "NOT visible to them — only your own assistant message is. Make sure those details are written in " +
        "your reply for this turn.",
    );
  }

  return { text: s, notes: noteList };
}

/** Remove timestamps and non-speech markers like [BLANK_AUDIO] from whisper output. */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*\[[\d:.\s\->]+\]\s*/, "")) // stray timestamps
    .join(" ")
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE|_[A-Z_]+_)[^\]]*\]/gi, " ")
    .replace(/\[\s*(?:silence|music|noise|inaudible)\s*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
