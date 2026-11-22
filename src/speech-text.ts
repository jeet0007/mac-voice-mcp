// Pure text helpers: screen text to ear text, and whisper transcript cleanup. See docs/specs/speech-output.md.

export interface PreparedSpeech {
  text: string;
  notes: string[];
}

export interface PrepareOptions {
  // 0 = no limit
  maxWords?: number;
  maxChars?: number;
}

// Deliberately specific: "above" or "see the" alone occur in ordinary speech ("see the doctor").
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

const OPENER =
  /^((?:okay|ok|sure|done|right|alright|all right|got it|found it|hmm|yes|yep|yeah|no|nope|great|good|perfect|so|well|cool|nice|thanks|thank you))[.!]\s+(?=[\p{L}\p{N}])(\S)/iu;

export function prepareSpeech(input: string, opts: PrepareOptions = {}): PreparedSpeech {
  const maxWords = opts.maxWords ?? 120;
  const maxChars = opts.maxChars ?? 4000;
  const notes = new Set<string>();
  let s = input.replace(/\r\n?/g, "\n");

  s = s.replace(/```[\s\S]*?(?:```|$)/g, () => {
    notes.add("code blocks");
    return "\n(I've left the code on screen.)\n";
  });
  s = s.replace(/(?:^[ \t]*\|.*\|[ \t]*$\n?){2,}/gm, () => {
    notes.add("tables");
    return "\n(There's a table on screen.)\n";
  });

  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    if (code.length <= 32 && !/[{}();=<>[\]$]/.test(code)) return code;
    notes.add("inline code");
    return "that code";
  });

  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ");

  s = s.replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*?(?=[.,;:!?)]*(?:\s|$))/g, (_m, host: string) => {
    notes.add("URLs");
    return `a link to ${host}`;
  });

  s = s.replace(/(?<![\w/:])(?:(?:~|\.{1,2})?(?:\/[\w@.+-]+){2,}|[\w@.+-]+(?:\/[\w@.+-]+){2,})\/?/g, (m) => {
    if (/^[\d/.-]+$/.test(m)) return m; // a date like 9/23/2026
    notes.add("file paths");
    const parts = m.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? m;
  });
  s = s
    .replace(/\b([\w-]+\.[a-z]{1,5}):\d+(?::\d+)?\b/gi, "$1")
    .replace(/(?<![\d/])(\d+)\/(\d+)(?![\d/])/g, "$1 of $2");

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
    .replace(/(\*\*|__|\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*(?:->|=>|→)\s*/g, " to ")
    .replace(/\s&\s/g, " and ")
    .replace(/[*_#~|^\\]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\.+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  s = s.replace(OPENER, "$1, $2");

  let cutNote: string | undefined;
  const words = s.split(" ");
  if (maxWords > 0 && words.length > maxWords) {
    let cut = words.slice(0, maxWords).join(" ");
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    if (lastStop > cut.length * 0.4) cut = cut.slice(0, lastStop + 1);
    s = `${cut} The rest is on screen.`;
    cutNote =
      `voice-mcp note: text_to_speak was too long (over ${maxWords} words), so only the first ${cut.split(" ").length} of ${words.length} words were spoken, ` +
      "then \"The rest is on screen.\" Make sure what you cut is in your on-screen reply, and keep spoken text short.";
  }
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    cutNote ??= `voice-mcp note: text_to_speak was too long, so it was cut at ${maxChars} characters. Keep spoken text short.`;
  }

  const noteList = notes.size
    ? [
        `voice-mcp note: text_to_speak was rewritten for speech (removed/shortened: ${[...notes].join(", ")}). ` +
          "Next time send only short, plain spoken sentences — keep code, paths, links and tables in your on-screen reply.",
      ]
    : [];
  if (cutNote) noteList.push(cutNote);

  // The input, not `s`: the added "The rest is on screen." must not trigger it.
  if (ON_SCREEN_PATTERN.test(input)) {
    noteList.push(
      "voice-mcp reminder: you told the user to look at something. Spoken text and Bash/tool output are " +
        "NOT visible to them — only your own assistant message is. Make sure those details are written in " +
        "your reply for this turn.",
    );
  }

  return { text: s, notes: noteList };
}

const SOUND_NOTES = /\[[^\]]*\]|\([^)]*\)|\*[^*\n]+\*|[♪♫]+/g;

// "Thank you." and "Bye." are real answers, so only sentences nobody says to a coding assistant.
const STOCK_SENTENCES = [
  /^(?:thanks|thank you)(?: (?:so|very) much)? for (?:watching|listening)(?: and see you next time)?$/,
  /^(?:please |don'?t forget to )?(?:like and )?subscribe(?: to (?:my|our|the) channel)?$/,
  /^(?:you can )?find the links? in the description(?: below)?$/,
  /^see you in the next (?:video|episode)$/,
  /^(?:subtitles|captions|transcription|translated|transcribed|subtitled) (?:by|provided by) .*$/,
];

const LOOSE_CREDITS = /^(?:subtitles|subtitled|captions|transcription|translated|transcribed)$/;

const squash = (sentence: string) => sentence.toLowerCase().replace(/[.!?,"“”]/g, "").replace(/\s+/g, " ").trim();
const isStockSentence = (sentence: string): boolean => STOCK_SENTENCES.some((re) => re.test(squash(sentence)));

export function cleanTranscript(raw: string, dropped?: string[]): string {
  const text = raw
    .split("\n")
    .map((l) => l.replace(/^\s*\[[\d:.\s\->]+\]\s*/, ""))
    .join(" ")
    .replace(SOUND_NOTES, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = text.match(/.+?(?:[.!?]+(?=\s|$)|$)/g) ?? []; // the "." in "1.2.3" or "Amara.org" doesn't end one
  if (sentences.length === 1 && LOOSE_CREDITS.test(squash(sentences[0]!))) {
    dropped?.push(sentences[0]!.trim());
    return "";
  }
  return sentences
    .filter((s) => {
      const stock = isStockSentence(s);
      if (stock) dropped?.push(s.trim());
      return !stock;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
