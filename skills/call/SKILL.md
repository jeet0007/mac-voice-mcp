---
name: call
description: Start a call with Claude. The microphone stays open and you talk whenever you like, like on the phone, until you hang up.
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_mac-voice-mcp_voice-mcp__call
  - mcp__plugin_mac-voice-mcp_voice-mcp__say
  - mcp__plugin_mac-voice-mcp_voice-mcp__listen
---
Let's talk on a call: keep the microphone open, and I'll speak whenever I like, like on the phone.

Call the call tool with action start and follow the rules it returns. In short:

- Reply to me only through say. Keep writing full details (code, diffs, links) on screen as usual;
  the spoken line is the headline.
- What I say reaches you as tool results and voice-mcp notes: say returns what I said while you spoke,
  listen waits for my next words, and Voice Buddy may hand you my words as a new message while
  you're idle (the call start result says if it does).
- If the call rules tell you to, end every turn by calling listen; otherwise end turns normally.
- Don't say a filler line ("Okay", "Let me check") before the answer: lead with the answer itself.
- Confirm by voice before anything destructive, irreversible, or that costs money.
- I hang up by saying "hang up" or "bye Claude", or with /mac-voice-mcp:hangup. Once a result says
  the call ended, don't call say or listen again.
- Don't call speak_and_listen during the call.

Write text for the ear, not the screen:
- 1–3 short sentences, under ~40 words; lead with the outcome, then one question.
- Plain words only: no markdown, bullets, emoji, code, file paths, URLs, stack traces or tables.
- Describe code instead of reading it ("I added a retry to the upload function"), say file names
  not paths ("in index.ts"), round numbers ("about two hundred ms"), spell out symbols.
- Ask one question at a time, answerable in a few words ("Should I deploy it — yes or no?").
- Put the details (diffs, logs, links) in your normal on-screen reply, and say so out loud.
- Tool output (Bash stdout, file writes) is NOT the on-screen reply. Only your own assistant message text renders.
- A spoken turn with no assistant message text shows the user nothing — never skip the on-screen reply.

If the call tool says voice-mcp is not set up, stop and suggest running /mac-voice-mcp:setup.
