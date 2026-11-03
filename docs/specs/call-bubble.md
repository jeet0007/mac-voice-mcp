# Call bubble (0.9.0)

Status: implemented (Unreleased) · Builds on: call mode (0.8.0) · Source: `native/call-bubble.swift`

## Goal

> "During a call I want to see it and control it from anywhere, like FaceTime's call pill."

A small floating pill shows while a call is on, above every app and on every desktop: Claude's blob
(orange speaking, blue listening, green on the line), the call's duration, a mute button and a
hang-up button. Clicking the blob brings the call's terminal or editor to the front. It never takes
focus from what you're typing.

## Principles

- **Built on the user's Mac, never downloaded:** the Swift source ships in the npm package and setup
  compiles it with `swiftc` after asking. No Apple Developer account, no notarization, nothing
  Gatekeeper blocks; anyone can read the source that runs. Same consent model as Kokoro.
- **Optional and harmless:** without the bubble (not built, no Command Line Tools, not macOS, or
  turned off) calls work exactly as in 0.8.0.
- **No new permissions:** the bubble only draws a window and reads and writes files in
  `voice-mode/`; it never touches the mic.
- **One source of truth:** the bubble reads `call.json` and `phase.json` and toggles `mute`, as the
  prototype does. The server owns the call; the bubble only reflects and requests.

## Design

### Build (setup)

- Source: `native/call-bubble.swift` (moved from `scripts/bubble-spike.swift`), added to `files` in
  package.json.
- `voice_setup` / `setup` on macOS: if `swiftc` is present, offer the bubble as an optional item
  ("a floating call window; built on this Mac in about 10 s"). On yes: compile with
  `swiftc -O` into `<cache>/bin/call-bubble`, plus `<cache>/bin/call-bubble.hash` holding the
  source's SHA-256, so a new version rebuilds once (on the next setup, or at call start if the hash
  differs and the user already opted in).
- No `swiftc`: say it needs Xcode's Command Line Tools (`xcode-select --install`; Homebrew users
  have them) and skip. Never fail setup over it.
- `setup --bubble` (CLI) and `voice_setup` with `bubble=true` build it; the setup report shows it.

### Run (call start and end)

- At call start, if the binary exists, matches the source hash and `VOICE_MCP_CALL_BUBBLE` isn't
  `0`: the server starts it (one instance per Mac: skip if one is running, pid in
  `voice-mode/bubble.pid`). It exits by itself when `call.json` disappears, and the server also
  kills it at call end and shutdown.
- It shows the call's duration from `call.json`'s `startedAt`.
- Remembers where it was dragged (a small `voice-mode/bubble.json`), on the screen it was on;
  falls back to top-right of the main screen if that screen is gone.

### Controls

| Control | Does |
|---|---|
| Blob | Brings the app hosting the call (terminal or editor) to the front |
| Mute | Toggles `voice-mode/mute`; the button shows the state, and so does Voice Buddy |
| Hang up | Removes `call.json`; the server ends the call as it does for a closed session |
| Drag | Moves it; position remembered |

### Mic glow

- While a call is on, the server writes `voice-mode/levels` ("<dB> <threshold dB>") about every
  60 ms, only for frames the mic hears (not muted, not while Claude speaks in half duplex).
- The bubble reads it once per 30 Hz tick and draws a soft glow outside the pill: strength and
  blur follow the level (-90 to -10 dB mapped to 0 to 1, smoothed), blue above the threshold
  (speech), grey below. No glow while muted, while Claude talks, or when the file is over 0.25 s old.
- The panel is the pill plus a 30 pt margin on each side for the glow. The window shadow is off
  (it follows content alpha, so it would shadow the glow too); the bubble draws the pill's shadow
  itself. `bubble.json` still holds the pill's origin.

### Voice Buddy

Shows "muted" on a muted call (grey, with a mute mark), so both views agree.

## Testing

- **Unit/e2e (stubs, CI on Linux and macOS):** a stub `call-bubble` binary logs start and stop:
  started at call start only when built and enabled, one instance, killed at call end and
  shutdown, not started when `VOICE_MCP_CALL_BUBBLE=0` or not built, rebuild when the hash differs.
- **macOS CI compile check:** the Tests workflow's macOS job runs `swiftc -typecheck` on the source,
  so a broken bubble fails CI.
- **On a real Mac (manual, before release):** appears within 1 s of call start and vanishes within
  1 s of the end; mute stops transcription; hang up ends the call; the blob brings the window
  forward; never steals typing focus; survives switching desktops and full-screen apps; remembers
  its position.

## Acceptance

| Check | Target |
|---|---|
| Bubble appears after call start | ≤ 1 s |
| Bubble gone after hang-up / session end | ≤ 1 s |
| Mute → nothing transcribed | 100% (e2e) |
| Build time on an M-series Mac | report it; < 20 s |
| Calls without the bubble | unchanged (all 0.8 tests pass) |

## Not in scope

Windows (no bubble there yet), a menu bar item, echo cancellation (its own 0.9.x work, though it can
reuse this build-on-setup pipeline for its native helper).
