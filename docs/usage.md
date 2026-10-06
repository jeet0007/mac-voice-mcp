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
