---
name: voice-help
description: How to use the Mac Voice speak_and_listen tool well, and how to fix it. Use when talking with the user by voice, when they ask about voice mode, or when voice turns misbehave (silent mic, cut-off replies, wrong words, robotic voice, slow turns).
---

# Using Mac Voice well

speak_and_listen says `text_to_speak` out loud, listens for one natural turn (it waits for the user to
start and stops when they pause), and returns an on-device whisper.cpp transcript.

## Speaking

Write for the ear: 1–3 short sentences, outcome first, one question at a time. No markdown, code, paths,
URLs or tables — describe them and put the details in the on-screen reply. The server also rewrites
anything unspeakable and says so in a "voice-mcp note"; follow those notes.

## Listening

- Transcripts contain homophones and mangled jargon: interpret generously, and confirm by voice before
  anything destructive or irreversible.
- "(No speech detected …)" is not consent. Ask once more, or continue with safe work and report on screen.
- Once the user talks by voice, stay in voice: answer every transcript with another speak_and_listen call
  until they say stop or start typing.
- The final "voice-mcp timing" line is diagnostics. Ignore it unless the user asks why things feel slow.

## Fixing problems

| Symptom | Cause and fix |
|---|---|
| "microphone returned pure digital silence" | The app running the server lacks mic access: System Settings → Privacy & Security → Microphone, allow it, then restart that app. |
| "voice-mcp is not set up" | Call voice_setup (check only), tell the user what's missing, install only after they agree. |
| Reply cut off ("may be cut off" note) | They hit the listening limit. Ask them to continue; for long dictation pass a larger `listen_seconds`. |
| Turn ends while they're still thinking | Set `VOICE_MCP_END_SILENCE_MS` higher (default 1200) in the server's environment. |
| Wrong words, names or jargon | Set `VOICE_MCP_WHISPER_PROMPT` to the names and terms, or use a bigger model (`VOICE_MCP_WHISPER_MODEL=small.en`, then voice_setup to download it). |
| Voice sounds robotic | Download a Premium voice: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. It's picked up automatically. `VOICE_MCP_VOICE` picks a specific one. |
| Other languages | `VOICE_MCP_WHISPER_MODEL=base` (multilingual) and `VOICE_MCP_LANGUAGE=auto` or a code such as `th`. |
| Slow turns | Read the timing line: "spoke" is the speech length, "transcribed" should be well under a second with the warm server. |
| An approval prompt on every turn | Add the tool to Claude Code's allow list (README: "Allow voice turns without prompts"). |
