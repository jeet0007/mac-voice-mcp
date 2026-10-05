---
name: setup
description: Check what Mac Voice needs (recorder, whisper.cpp, speech model, voice), install what's missing with your OK, then test a spoken turn.
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_mac-voice-mcp_voice-mcp__speak_and_listen
---

Set up Mac Voice (voice-mcp) on this computer.

1. Call voice_setup (check only) and give me a short summary of what's already installed and what's missing.
2. If something is missing, ask me before installing. Only if I agree, call voice_setup with install=true.
   If it reports INSTALLING, wait a minute and check again until it's READY.
3. When it reports READY, test it: call speak_and_listen with a one-sentence greeting that asks me to say
   something back, then tell me what you heard. If the result says the microphone returned silence, walk me
   through allowing microphone access in System Settings → Privacy & Security → Microphone.
4. If the report has an optional voice tip (•), mention it once: a Premium voice sounds far more natural. The Kokoro voice is the other option (`voice_setup` with `kokoro=true`, only after the user agrees).
5. Finally, tell me I can start a voice conversation any time with /mac-voice-mcp:talk, and that I can skip
   the approval prompt on every voice turn by allowing the tool (see "Allow voice turns without prompts"
   in the README).
