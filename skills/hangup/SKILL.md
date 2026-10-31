---
name: hangup
description: End the call with Claude.
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_mac-voice-mcp_voice-mcp__call
---
Hang up: call the call tool with action end, then confirm on screen in one line. If it says no call
is on, just say so.
