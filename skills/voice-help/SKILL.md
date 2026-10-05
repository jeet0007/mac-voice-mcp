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
- "(No speech detected …)" is not consent. Ask once more out loud. If there's still no answer, stop: say on
  screen that voice mode is paused and they can type anything (or run /mac-voice-mcp:talk) to carry on. Don't
  tell them to speak: the mic is off until you call speak_and_listen again.
- Once the user talks by voice, stay in voice: answer every transcript with another speak_and_listen call
  until they say stop or start typing. The plugin's hook enforces this: if you try to finish with a
  text-only reply while voice mode is on, you'll be sent back once to answer by voice.
- To end voice mode, or for a one-way announcement, call speak_and_listen with `listen: false`: it speaks
  without opening the mic, and voice mode ends. Voice mode also ends when the user types, or doesn't answer.
- The final "voice-mcp timing" line is diagnostics. Ignore it unless the user asks why things feel slow.

## Fixing problems

| Symptom | Cause and fix |
|---|---|
| Not sure what's wrong | Have the user run `npx -y mac-voice-mcp@latest doctor` in a terminal: it checks setup, voice → transcript, and speakers → mic, each PASS / WARN / FAIL. |
| "microphone returned pure digital silence" | Usually the app running the server lacks mic access: System Settings → Privacy & Security → Microphone, allow it, then restart that app. If the message says it's recording with ffmpeg, suggest `brew install sox` first. |
| "voice-mcp is not set up" | Call voice_setup (check only), tell the user what's missing, install only after they agree. |
| Reply cut off ("may be cut off" note) | They hit the listening limit. Ask them to continue; for long dictation pass a larger `listen_seconds`. |
| Turn ends while they're still thinking | Set `VOICE_MCP_END_SILENCE_MS` higher (default 1200) in the server's environment. |
| Wrong words, names or jargon | Set `VOICE_MCP_WHISPER_PROMPT` to the names and terms, or use a bigger model (`VOICE_MCP_WHISPER_MODEL=small.en`, then voice_setup to download it). |
| Voice sounds robotic | Download a Premium voice: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. It's picked up automatically. `VOICE_MCP_VOICE` picks a specific one. |
| Other languages | `VOICE_MCP_WHISPER_MODEL=base` (multilingual) and `VOICE_MCP_LANGUAGE=auto` or a code such as `th`. |
| Slow turns | Read the timing line: "spoke" is the speech length, "transcribed" should be well under a second with the warm server. |
| "Another voice session on this Mac…" | Another Claude window, Claude Desktop or Cursor held the speaker and mic for over 2 minutes (`VOICE_MCP_LOCK_WAIT_SECONDS`). Tell the user on screen, and try again once that conversation is over. |
| Sent back to answer by voice when you meant to stop | The voice-mode hook thinks the conversation is still going. Say goodbye with `listen: false`. The user can switch the hook off with `VOICE_MCP_STAY_IN_VOICE=0` in Claude Code's settings `env`. |
| An approval prompt on every turn | Add the tool to Claude Code's allow list (README: "Allow voice turns without prompts"). |
