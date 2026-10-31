# Using it

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

- **"Work on X and check in with me by voice when you need a decision."** Claude works quietly and only speaks at decision points.
- **`/mac-voice-mcp:talk fix the flaky login test`** (plugin), or **`/mcp__voice-mcp__voice_mode fix the flaky login test`** (added by hand). Claude reads its plan back to you, then checks in at each checkpoint. Say "stop voice mode" or "I'm back" to end it.
- **"Read me a 20-second summary of this PR and ask if I should approve it."** Use this for one-off briefings.
- **Just talk after the chime.** You don't need to hurry or fill silence. If you're still talking at the 30-second safety cap (`listen_seconds`), Claude is told your reply may be cut off and asks you to continue.

## Voice mode

Once you answer out loud, you're in a voice conversation. Claude replies by voice, not in text, until one of these happens:

- **You type something.** You're back at the keyboard.
- **You say you're done.** Claude says a short goodbye without opening the mic (`speak_and_listen` with `listen: false`).
- **You don't answer.** After 15 seconds of silence Claude asks once more. If you still don't answer, it pauses and summarizes on screen, and the mic stays off. Type anything, or run `/mac-voice-mcp:talk`, to pick up again.

In Claude Code, the plugin enforces this with a hook. If Claude tries to answer in text mid-conversation, the hook sends it back once to answer by voice. If it stops again, the hook lets it. To turn the hook off, add `"VOICE_MCP_STAY_IN_VOICE": "0"` to the `env` block in `~/.claude/settings.json`. Other apps rely on the instructions alone.

## Calls

A call keeps the line open, like a phone call: the mic stays on until you hang up, so you can talk whenever you like instead of waiting for Claude to ask.

- **Start:** `/mac-voice-mcp:call` (Claude Code), or the **call** prompt in Claude Desktop and Cursor. Claude says "I'm here."
- **Talk anytime.** While Claude works, what you say reaches it at its next step. While it waits, Voice Buddy hands it over as your next message, within a fraction of a second. Without Voice Buddy (and in Claude Desktop and Cursor), Claude keeps listening between replies instead.
- **Silence is fine.** A call never ends because you're quiet. It ends after 30 minutes with nothing said either way (`VOICE_MCP_CALL_IDLE_MINUTES`).
- **Hang up:** say "hang up" or "bye Claude", or run `/mac-voice-mcp:hangup`. Closing the session ends the call too.
- **Typing doesn't end the call or cut Claude off.** Type whenever you want; the call stays on.

**Talking over Claude needs headphones.** On speakers the mic is muted while Claude speaks, so it doesn't hear itself. With headphones (the headphone jack, or Bluetooth headphones such as AirPods), the mic stays open: a quarter second of your voice pauses Claude. Say something real and it stops and answers you; a quick "mm-hmm" or a cough lets it carry on. voice-mcp checks for headphones when the call starts; `VOICE_MCP_CALL_DUPLEX` overrides it ([Configuration](configuration.md#calls)).

**One call at a time.** While you're on a call, voice in other windows (other Claude Code sessions, Claude Desktop, Cursor) says you're on a call elsewhere instead of opening the mic.

**Long commands:** while Claude runs a long command in the foreground, such as a full test run, what you say waits until it finishes. Ask Claude to run long commands in the background during a call.

## Voice Buddy: see the voice, type to interrupt

**Voice Buddy** is an optional companion plugin for Claude Code:

```
/plugin install voice-buddy@mac-voice-mcp
```

**The buddy.** While voice is on in a window, a small animated blob sits above the prompt and shows what the voice turn is doing:

| Colour | Means |
|---|---|
| Orange, lively | Claude is speaking |
| Blue, breathing | Listening for your answer |
| Purple, quick | Got it, transcribing |
| Grey | Waiting for another voice session to finish |
| Green, calm | Listening for "Claude, …" while Claude works |

It's drawn with coloured blocks in the terminal and as a smooth animated shape in the desktop app and VS Code. Each window shows only its own voice.

### Interrupt by typing

Without Voice Buddy, what you type during a voice turn waits until the turn is over: up to 15 seconds while voice-mcp waits for you to speak. With it, your first keystroke stops Claude talking and listening at once (within about a tenth of a second), and Claude waits for your typed message instead of asking again by voice.

- **It works during** a voice turn, a spoken update that's still playing ("Give me a few minutes"), and listening while Claude works ("Claude, …").
- **Only your own window counts.** Typing in another Claude window leaves this one alone.
- **Typing ends voice mode,** as it always has. Run `/mac-voice-mcp:talk` to pick up again.
- **It's a Claude Code mod,** an early-access kind of plugin. If a Claude Code update ever breaks it, voice keeps working, and **Esc** still interrupts a voice turn.

Without Voice Buddy, press **Esc** to interrupt, then type.

## Talk to Claude while it works

In Claude Code with the plugin, after you answer out loud the mic stays open while Claude works. Start with Claude's name and say what you want:

- *"Claude, use the other branch."*
- *"Hey Claude, skip the slow tests."*
- *"Claude?"* on its own tells Claude you want to talk.

A soft sound tells you it was heard. Claude gets it after its next step (its next tool call), or as soon as it finishes, and takes it into account. If Claude speaks to you first, it gets it in that turn instead.

- **Only speech that starts with "Claude" is passed on.** Everything else the mic picks up (you talking to someone, a call, a video) is transcribed on your Mac, checked for the name, and dropped. Nothing is stored or sent anywhere.
- **macOS shows the orange mic dot** while this is on.
- **It pauses** while Claude speaks to you (the turn takes the mic), and carries on after a quick update that doesn't wait for an answer, such as "Give me a few minutes."
- **It stops** within a quarter of a second when you type, when Claude finishes, when voice mode ends, when you talk in another Claude window, and after 10 minutes without a voice turn (`VOICE_MCP_WORK_LISTEN_MINUTES`).
- **It goes to the main Claude.** If Claude has started helper agents, what you say waits for Claude itself, not for a helper.
- **To turn it off,** set `"VOICE_MCP_LISTEN_WHILE_WORKING": "0"` in the `env` block of `~/.claude/settings.json`.

It needs the plugin's hook, so it only works in Claude Code with the plugin. Claude Desktop and Cursor never keep the mic open between turns.

**Several sessions, one mic.** Every mac-voice-mcp on your Mac takes turns: Claude Code windows, Claude Desktop and Cursor. While one is speaking or listening, the others wait for that turn to finish (shown as "waiting for another voice session"). They give up after 2 minutes with a message. If a session crashes, the next one takes the mic over.

## Getting Claude to sound natural

Guidance reaches Claude through several channels, because each client shows different ones:

| Channel | Who sees it |
|---|---|
| Tool description (rules plus a good and a bad example) | Every client |
| Server instructions (when to use voice, how to handle replies, setup) | Claude Code (it reads up to 2 KB) |
| The `voice_mode` and `setup` prompts | Claude Code (as slash commands), Claude Desktop, Cursor |
| Server-side rewrite plus a `voice-mcp note` back to Claude | Always on |
| The plugin's `/mac-voice-mcp:talk`, `voice-help` skill and stay-in-voice hook | Claude Code, with the plugin |

The rules Claude is given:

```
- 1–3 short sentences, under ~40 words; lead with the outcome, then one question.
- Plain words only: no markdown, bullets, emoji, code, file paths, URLs, stack traces or tables.
- Describe code instead of reading it, say file names not paths, round numbers, spell out symbols.
- Ask one question at a time, answerable in a few words.
- Put the details (diffs, logs, links) in the on-screen reply, and say so out loud.
```

The safety net turns `## Results\n- \`npm test\` ✅ 42/42\n- see /Users/x/repo/src/index.ts:120` into *"Results. npm test 42 of 42. see index.ts."*

Claude Desktop ignores server instructions. To make the rules stick there, paste [`examples/CLAUDE.md`](../examples/CLAUDE.md) into *Settings → Profile → personal preferences* or into a Project's instructions. For Claude Code, add it to `CLAUDE.md`. For Cursor, copy [`examples/voice-mcp.mdc`](../examples/voice-mcp.mdc) to `.cursor/rules/`.
