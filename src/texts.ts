/**
 * Everything the model reads: speaking rules, server instructions, tool
 * descriptions and prompts. The rules are shared so every client sees the same
 * guidance through whichever channel it actually surfaces (Claude Desktop, for
 * instance, ignores server instructions but always shows tool descriptions).
 */

export const SPEECH_RULES = [
  "Write text_to_speak for the ear, not the screen:",
  "- 1–3 short sentences, under ~40 words; lead with the outcome, then one question.",
  "- Plain words only: no markdown, bullets, emoji, code, file paths, URLs, stack traces or tables.",
  '- Describe code instead of reading it ("I added a retry to the upload function"), say file names',
  '  not paths ("in index.ts"), round numbers ("about two hundred ms"), spell out symbols.',
  '- Ask one question at a time, answerable in a few words ("Should I deploy it — yes or no?").',
  "- Put the details (diffs, logs, links) in your normal on-screen reply, and say so out loud.",
].join("\n");

/** Claude Code reads these (truncated at 2 KB) — keep under that. */
export const SERVER_INSTRUCTIONS = [
  "voice-mcp speaks to the user through their computer's speakers and returns a local transcript of",
  "their spoken reply (tool: speak_and_listen). Use it when the user asked to be kept in the loop by",
  "voice, is in a voice/hands-free session, or you need a quick decision while they may be away from",
  "the keyboard. Do not use it for routine output the user can read on screen.",
  "",
  SPEECH_RULES,
  "",
  "Handling replies:",
  "- The result is a speech-to-text transcript: expect homophones and mangled jargon; interpret",
  "  generously, and confirm by voice before anything destructive or irreversible.",
  '- "(No speech detected …)" means no answer: never treat silence as consent. Ask once more or',
  "  continue with safe work and report on screen.",
  "- Once the user is talking with you by voice, stay in voice: answer every turn with speak_and_listen,",
  "  not a text reply, until they say stop or start typing.",
  "- Listening ends on its own when the user stops talking; no need to set listen_seconds.",
  '- If the result includes a "voice-mcp note", follow it.',
  "",
  "Setup: if speak_and_listen says voice-mcp is not set up, call voice_setup (check only), tell the user",
  "what is missing, and call voice_setup with install=true only after they agree.",
].join("\n");

export const SPEAK_TOOL_DESCRIPTION = [
  "Say something out loud to the user and hear their spoken reply.",
  "Speaks text_to_speak through the computer's speakers, then listens like a conversation turn — it waits for",
  "the user to start talking and stops when they finish — and returns an on-device transcript of what they said.",
  "",
  SPEECH_RULES,
  "",
  'Good: "The build passed and all tests are green. Want me to open the pull request?"',
  'Bad: "## Results\\n- `npm test` ✅ 42/42\\n- see /Users/x/repo/src/index.ts:120"',
  "",
  "Once the user is talking with you by voice, keep the conversation in voice: answer each transcript with",
  "another speak_and_listen call (not a text reply) until they say stop or start typing.",
  'A reply of "(No speech detected …)" means the user did not answer — never treat it as consent.',
  "If it reports that voice-mcp is not set up, call voice_setup.",
].join("\n");

export const SETUP_TOOL_DESCRIPTION = [
  "Check whether this computer has everything speak_and_listen needs — text-to-speech, a microphone recorder (SoX),",
  "whisper.cpp speech-to-text and the speech model — and optionally install what's missing.",
  "Anything already installed is reused (an existing model elsewhere on disk is symlinked, not re-downloaded).",
  "Call it with install=false (the default) first and tell the user what is missing.",
  "Only call it with install=true after the user agrees: it runs `brew install` for the missing packages",
  "and downloads the speech model once. It never uninstalls or changes anything else.",
  'If it reports INSTALLING, the install continues in the background — wait a minute and call it again to check.',
].join("\n");

export const SETUP_PROMPT = [
  "Set up voice-mcp on this computer.",
  "1. Call voice_setup (check only) and give me a short summary of what's already installed and what's missing.",
  "2. If something is missing, ask me before installing. Only if I agree, call voice_setup with install=true.",
  "   If it reports INSTALLING, wait a minute and check again until it's READY.",
  "3. When it reports READY, test it: call speak_and_listen with a one-sentence greeting that asks me to say something back,",
  "   then tell me what you heard. If the result says the microphone returned silence, walk me through",
  "   allowing microphone access in System Settings → Privacy & Security → Microphone.",
].join("\n");

export const VOICE_MODE_PROMPT = (task?: string) =>
  [
    "Let's work in voice mode. I may be away from the screen, so keep me in the loop through the",
    "speak_and_listen tool instead of waiting for me to type.",
    "",
    "- This is a spoken conversation. Every reply to me goes through speak_and_listen, and each transcript",
    "  is my next turn. Don't fall back to text replies until I say \"stop voice mode\" or \"I'm back\".",
    "- While you work on something, say briefly what you're about to do, do it, then report back by voice.",
    "  Don't narrate every small action.",
    "- If a transcript is unclear, ask again by voice.",
    "- Confirm by voice before anything destructive, irreversible, or that costs money.",
    "- If I don't answer, don't assume yes: carry on with safe work or pause, and summarize on screen.",
    "- Keep writing full details (code, diffs, links) on screen as usual; the voice line is the headline.",
    '- Stop using voice when I say "stop voice mode", "I\'m back", or start typing again.',
    "",
    SPEECH_RULES,
    "",
    task
      ? `Start by briefly telling me out loud what you're about to do for: ${task}. Then ask if I want to change anything.`
      : "Start by calling speak_and_listen to say voice mode is on and ask what I'd like to work on.",
  ].join("\n");
