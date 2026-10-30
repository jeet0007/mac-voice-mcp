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
  "- Tool output (Bash stdout, file writes) is NOT the on-screen reply. Only your own assistant message text renders.",
  "- A spoken turn with no assistant message text shows the user nothing — never skip the on-screen reply.",
].join("\n");

/** Claude Code reads these (truncated at 2 KB) — keep under that. */
export const SERVER_INSTRUCTIONS = [
  "voice-mcp speaks to the user through their computer's speakers and returns a local transcript of",
  "their spoken reply (tool: speak_and_listen). Use it when the user asked to be kept in the loop by",
  "voice, is in a hands-free session, or you need a quick decision while they may be away from the",
  "keyboard. Not for routine output the user can read on screen.",
  "",
  SPEECH_RULES,
  "",
  "Handling replies:",
  "- The result is a speech-to-text transcript: expect homophones and mangled jargon; interpret",
  "  generously, and confirm by voice before anything destructive or irreversible.",
  '- "(No speech detected …)" means no answer: never treat silence as consent. Ask once more or',
  "  continue with safe work and report on screen.",
  "- Once the user is talking with you by voice, stay in voice: answer every turn with speak_and_listen,",
  "  not a text reply, until they say stop (say goodbye with listen: false) or start typing.",
  '- If the result includes a "voice-mcp note", follow it.',
  "",
  "A call (mic open until the user hangs up): the call tool starts and ends it; then speak with say",
  "and hear the user with listen, not speak_and_listen.",
  "Setup: if a tool says voice-mcp is not set up, call voice_setup (check only); install=true only",
  "after the user agrees.",
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
  "To end voice mode, or for a one-way announcement, pass listen: false: it returns at once and speaks while you work.",
  'A reply of "(No speech detected …)" means the user did not answer — never treat it as consent. Ask once more;',
  "if still nothing, stop and say on screen that voice mode is paused and they can type to carry on (not speak: the mic is off).",
  'The "voice-mcp timing" line at the end is diagnostics: ignore it unless the user asks why things feel slow.',
  "If it reports that voice-mcp is not set up, call voice_setup.",
].join("\n");

export const SETUP_TOOL_DESCRIPTION = [
  "Check whether this computer has everything speak_and_listen needs — text-to-speech, a microphone recorder (SoX),",
  "whisper.cpp speech-to-text and the speech model — and optionally install what's missing.",
  "Anything already installed is reused (an existing model elsewhere on disk is symlinked, not re-downloaded).",
  "Call it with install=false (the default) first and tell the user what is missing.",
  "Only call it with install=true after the user agrees: it runs `brew install` for the missing packages",
  "and downloads the speech model once. It never uninstalls or changes anything else.",
  "kokoro=true (also only after the user agrees) installs the optional Kokoro voice: more natural than the built-in one,",
  "runs on this Mac, about 1 GB on disk. Once installed it's used automatically; the built-in voice stays as the fallback.",
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
    "- If I don't answer, don't assume yes: ask once more out loud. If there's still nothing, pause and summarize",
    "  on screen, and tell me to type anything to pick up again (the mic is off, so don't tell me to speak).",
    "- Keep writing full details (code, diffs, links) on screen as usual; the voice line is the headline.",
    '- Stop using voice when I say "stop voice mode", "I\'m back", or start typing again. To end it, say a short',
    "  goodbye with speak_and_listen and listen: false (it speaks without opening the mic).",
    "",
    SPEECH_RULES,
    "",
    task
      ? `Start by briefly telling me out loud what you're about to do for: ${task}. Then ask if I want to change anything.`
      : "Start by calling speak_and_listen to say voice mode is on and ask what I'd like to work on.",
  ].join("\n");

// --- A call: the mic stays open until the user hangs up (src/call.ts) ---------------------------

export const CALL_TOOL_DESCRIPTION = [
  "Start or end a call: a hands-free session where the microphone stays open and the user talks whenever they",
  "like, like a phone call, until they hang up. action start takes the speaker and microphone, says a short",
  "greeting and returns the rules of the call; action end hangs up (also happens when the user says",
  '"hang up" or "bye Claude", or after a long silence). During the call, speak with say and hear the user with listen.',
].join("\n");

export const SAY_TOOL_DESCRIPTION = [
  "During a call: say text out loud and return at once, so you carry on working while it plays. Typing interrupts it.",
  "The result includes anything the user said meanwhile. Only during a call: use speak_and_listen otherwise.",
  "",
  SPEECH_RULES.replace("text_to_speak", "text"),
].join("\n");

export const LISTEN_TOOL_DESCRIPTION = [
  "During a call: return what the user has said since you last heard from them, at once if something is waiting,",
  "otherwise wait up to wait_seconds (default and maximum 40) for their next words.",
  '"(still on the call, nothing said)" means nobody spoke yet: call listen again to keep waiting, or say something.',
  "Once it reports that the call ended, don't call it again.",
].join("\n");

/** What `call start` returns. */
export const CALL_RULES = [
  "The call is on: the microphone stays open until the user hangs up.",
  "- Reply to the user only through say (the same speaking rules as speak_and_listen). Keep the full details",
  "  (code, diffs, links) on screen as usual; the spoken line is the headline.",
  "- What the user says reaches you as tool results and voice-mcp notes: say returns what they said while",
  "  you spoke, and listen waits for their next words.",
  "- End every turn by calling listen, so you hear them while you're idle. Exception: if a note after this",
  "  result says Voice Buddy delivers what the user says while you're idle, end turns normally and don't call listen.",
  '- The user hangs up by saying "hang up" or "bye Claude"; you can end the call with call action end. Once it has ended, say nothing more: write "Call ended." on screen.',
  "- Don't call speak_and_listen during the call.",
].join("\n");

export const CALL_ALREADY_ON = "(A call is already on. Speak with say and hear the user with listen.)";
export const CALL_ENDED_BY_CLAUDE = "(The call ended. The microphone is off; the user can type, or start a new call.)";
export const NO_CALL = "(No call is on. Start one with the call tool, action start, or use speak_and_listen for a single voice turn.)";
export const ON_CALL_USE_SAY = "(You're on a call with the user: speak with say and hear them with listen, not speak_and_listen.)";
export const STILL_ON_CALL = "(still on the call, nothing said) Call listen again to keep waiting, or say something.";
export const callEnded = (reason: string) => `(The call ended: ${reason}. Don't call listen or say again; the user can type, or start a new call.)`;
export const SAID = "(Said. The microphone stays open, so carry on; what the user says next comes with your next say or listen.)";
export const CALL_GREETING = "I'm here.";

export const CALL_PROMPT = [
  "Let's talk on a call: keep the microphone open and I'll speak whenever I like, like on the phone.",
  "Call the call tool with action start and follow the rules it returns: reply to me through say, hear me",
  "with listen, and keep the full details on screen. Confirm by voice before anything destructive or irreversible.",
  "",
  SPEECH_RULES.replace("text_to_speak", "text"),
].join("\n");
