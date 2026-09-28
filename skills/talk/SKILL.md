---
name: talk
description: Start a hands-free voice conversation with Claude through the speakers and microphone. Optionally name a task to work on.
argument-hint: "[task to work on]"
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_mac-voice-mcp_voice-mcp__speak_and_listen
---

Let's work in voice mode. I may be away from the screen, so keep me in the loop through the
speak_and_listen tool instead of waiting for me to type.

- This is a spoken conversation. Every reply to me goes through speak_and_listen, and each transcript
  is my next turn. Don't fall back to text replies until I say "stop voice mode" or "I'm back".
- While you work on something, say briefly what you're about to do, do it, then report back by voice.
  Don't narrate every small action.
- If a transcript is unclear, ask again by voice.
- Confirm by voice before anything destructive, irreversible, or that costs money.
- If I don't answer, don't assume yes: ask once more out loud. If there's still nothing, pause and summarize
  on screen, and tell me to type anything or run /mac-voice-mcp:talk to pick up again (the mic is off, so
  don't tell me to speak).
- Keep writing full details (code, diffs, links) on screen as usual; the voice line is the headline.
- Stop using voice when I say "stop voice mode", "I'm back", or start typing again. To end it, say a short
  goodbye with speak_and_listen and listen: false (it speaks without opening the mic).

Write text_to_speak for the ear, not the screen:
- 1–3 short sentences, under ~40 words; lead with the outcome, then one question.
- Plain words only: no markdown, bullets, emoji, code, file paths, URLs, stack traces or tables.
- Describe code instead of reading it ("I added a retry to the upload function"), say file names
  not paths ("in index.ts"), round numbers ("about two hundred ms"), spell out symbols.
- Ask one question at a time, answerable in a few words ("Should I deploy it — yes or no?").
- Put the details (diffs, logs, links) in your normal on-screen reply, and say so out loud.
- Tool output (Bash stdout, file writes) is NOT the on-screen reply. Only your own assistant message text renders.
- A spoken turn with no assistant message text shows the user nothing — never skip the on-screen reply.

If speak_and_listen says voice-mcp is not set up, stop and suggest running /mac-voice-mcp:setup.

Task: $ARGUMENTS

If a task is given above, start by briefly telling me out loud what you're about to do for it, then ask
if I want to change anything. If it's empty, start by calling speak_and_listen to say voice mode is on
and ask what I'd like to work on.
