# Live transcript next to the call bubble (unreleased)

Status: in progress · Owner: Jeet · Target: next minor

## Goal

> "Show a live transcript on an attached window as I speak, so I know it heard correctly. Only visible when
> I talk, and gone when it isn't hearing any words."

During a call, a small panel attached to the floating call bubble shows the user's words while they speak,
then the final transcript for a moment, then fades away.

## Scope

- **v1: calls.** The panel belongs to the call bubble (native/call-bubble.swift), which runs during calls.
- **Not in v1:** plain `speak_and_listen` turns (no bubble runs then), Voice Buddy's in-terminal status line
  (it reads files, and partial words must not go to disk), a transcript history, editing a transcript.

## How it works

1. **Partials.** While the user is talking in a call, the server re-transcribes the current utterance with the
   warm `whisper-server` about every 700 ms (`VOICE_MCP_LIVE_TRANSCRIPT_MS`, 400-2000):
   - only when at least 0.5 s of speech is in the utterance and no partial request is in flight;
   - not when the last 300 ms were quiet (the utterance is probably ending; no new words to show, and the
     final transcript must not queue behind a partial);
   - audio goes in memory (a WAV buffer in the request body), at most the last 30 s;
   - a reply older than the newest one shown is dropped;
   - the text passes through `cleanTranscript`; an empty result shows nothing.
   - Never with the `whisper-cli` fallback (one process per request is too slow): no server, no partials.
2. **Final.** The existing per-utterance transcript (call.ts `heard`) is sent as the final text. Partials are
   display only: they never reach the inbox, Claude, logs or the flight recorder.
3. **Transport.** The server that launched the bubble writes one JSON object per line to the bubble's stdin:
   `{"type":"partial","text":"…"}`, `{"type":"final","text":"…"}`, `{"type":"clear"}`. No files, no sockets.
   A bubble started by another server process gets no text (it keeps working as today).
4. **Switch.** `VOICE_MCP_LIVE_TRANSCRIPT=1` (default) or `0`. With the bubble off, nothing runs.

## UX

Designed by the Voice MCP UX Designer. Everything here is for `native/call-bubble.swift` (AppKit, no new
dependencies). One new window, one new view, one stdin reader. Numbers are points (pt) unless marked ms.

### Principles

1. **Quiet.** Nothing on screen until words exist; gone about 2 s after the last new word.
2. **Never in the way.** Never key, never main, never takes a click (click-through), never moves the pill.
3. **Newest words win.** Long speech shows its tail, never its head.
4. **Honest.** What shows is what whisper heard so far. Partial text looks provisional; final looks settled.

### Window

A second `NSPanel`, the **transcript panel**, attached to the bubble panel as a child window
(`bubble.addChildWindow(tp, ordered: .above)`), so it follows every drag of the pill with no code.

| Property | Value |
|---|---|
| Class | `final class TranscriptPanel: NSPanel`, `canBecomeKey` and `canBecomeMain` both `false` |
| styleMask | `[.borderless, .nonactivatingPanel]` |
| level | `.floating` (same as the pill) |
| collectionBehavior | `[.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]` |
| ignoresMouseEvents | **`true`**: click-through. Clicks go to whatever is underneath. To move it, drag the pill. |
| isOpaque / backgroundColor | `false` / `.clear` |
| hasShadow | `true` (system shadow follows the rounded mask); call `invalidateShadow()` after each resize |
| hidesOnDeactivate | `false` |
| Shown with | `orderFront(nil)`, never `makeKey…`, never `NSApp.activate`. Hidden with `orderOut(nil)` once faded, so it costs nothing and VoiceOver can't see it while hidden |
| Initial state | Not ordered in. No window exists on screen until the first text. |

### Placement

All coordinates are in screen space; `pill` is the pill's rect (the panel's frame inset by `margin` = 30, so
the glow's transparent margin is ignored).

```
          screen.visibleFrame (excludes menu bar and Dock)
 ┌─────────────────────────────────────────────────────────────┐
 │                          ╭──────────────────────╮           │
 │                          │ ●  1:42   (mic) (end)│  pill     │
 │                          ╰──────────────────────╯           │
 │                              ↕ gap 8                        │
 │                ╭───────────────────────────────────╮        │
 │                │ …so I think we should move the    │ ← 3 lines max
 │                │ retry into the upload function    │   newest at the bottom
 │                │ and add a short back-off          │        │
 │                ╰───────────────────────────────────╯        │
 └─────────────────────────────────────────────────────────────┘
```

- **Side.** Default **below** the pill, **gap 8** between the pill's edge and the panel. Choose per
  appearance (not while visible): below if `pill.minY - 8 - 80 >= visible.minY + 8`; else above if
  `pill.maxY + 8 + 80 <= visible.maxY - 8`; else whichever side has more room, with the line cap reduced to
  `floor((room - 20) / 20)` (minimum 1). 80 is the tallest the panel gets (3 lines).
- **Anchoring.** The edge facing the pill stays fixed and the panel grows away from it (down when below,
  up when above), so the text never jumps toward the pill.
- **Horizontal.** Centred on the pill's `midX`, then clamped so the panel is at least **8** inside
  `visible` on both sides. The pill sits at the screen's right edge by default, so the panel is
  usually pushed left to align its right edge 8 in from the edge.
- **Screen.** The screen that contains the pill's centre; fall back to `NSScreen.main`. Use `visibleFrame`.
- **While visible and dragged.** Follows the pill (child window); re-clamped to the screen on
  `NSWindow.didMoveNotification`; the side is not re-chosen until the next appearance.
- **Overlap.** The panel may cover part of the pill's glow (transparent margin); it never covers the pill.

### Size and text fit

| Property | Value |
|---|---|
| Max width | **360**, or `visible.width - 16` if that is smaller |
| Min width | **120** |
| Width rule | `clamp(textWidth + 28, 120, 360)`. It only grows during one utterance (never shrinks, so it doesn't breathe with every partial); resets when hidden |
| Padding | 14 left and right, 10 top and bottom |
| Max lines | **3** (80 tall: 3 × 20 + 20). One line is 40 tall. |
| Corner radius | **16** (rounded rect, applied with a mask image on the visual effect view, like the pill) |
| Hairline | 0.5 inside border, white at 10% alpha |

**Long text.** Keep the newest words. Take at most the last 400 characters, measure with
`NSAttributedString.boundingRect(with: NSSize(width: contentWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])`.
If taller than 60 (3 lines), binary-search the smallest start offset (by `Character`, snapped forward to the
next space when one is within 12 characters) that fits, and prefix `"… "`. So the display is always
`… newest words`, never a clipped first line. Never scroll, never truncate the tail.

### Type

| Property | Value |
|---|---|
| Font | `NSFont.systemFont(ofSize: 15, weight: .regular)` (SF Pro). 15 pt is fixed: macOS has no Dynamic Type; users who need bigger text use Zoom |
| Line height | exactly 20 (`NSMutableParagraphStyle` `minimumLineHeight = maximumLineHeight = 20`) |
| Alignment | `.natural` (right-to-left languages stay correct), left in LTR |
| Wrapping | `.byWordWrapping` (AppKit breaks CJK by character on its own) |
| Control | `NSTextField` label: not editable, not selectable, `maximumNumberOfLines = 3`, `usesSingleLineMode = false` |
| Kerning, italics | none; italics hurt legibility at 15 pt |

### Material and colours

The panel matches the call bubble: a dark frosted glass in **both** system appearances. The pill is forced
dark (`darkAqua`, `.hudWindow`), the panel sits beside it, and a light panel next to a dark pill looks like two
products. Dark glass is also readable over any wallpaper or window. (Considered and rejected: a light variant
following the system. It adds a second palette to verify for no gain.)

| Part | Value |
|---|---|
| Glass | `NSVisualEffectView`, `material = .hudWindow`, `blendingMode = .behindWindow`, `state = .active`, `appearance = NSAppearance(named: .darkAqua)`, shaped by `maskImage` |
| Partial text | white at **72%** alpha (`NSColor(white: 1, alpha: 0.72)`) |
| Final text | white at **96%** alpha |
| Worst-case contrast | partial on `#4A4A4C` (the lightest the glass gets over a bright backdrop): about **5.5:1**; final: above **11:1**. Both pass WCAG AA (4.5:1) |
| Light and dark system modes | identical (forced dark glass); verify once in each |

**Partial versus final** (luminance, not hue, so it also works without colour):

| | Partial | Final |
|---|---|---|
| Alpha | 72% | 96% |
| Weight, size | same (regular 15), so words don't reflow when it settles | same |
| Change | text swaps instantly on each partial (no cross-fade: partials rewrite words and a fade would shimmer) | alpha animates 72% → 96% over **120 ms** (no animation under Reduce Motion: instant) |

The final replaces the last partial in place; it may differ by a word or two (whisper's full pass is better).

### Timing

| Event | Behaviour |
|---|---|
| First non-empty text (partial, or a final with no partial) | Order in, then **fade in 120 ms** (ease-out) with a **6 pt** slide from the pill's side toward its place. Empty or whitespace-only text never shows. |
| Each new partial with different text | Swap text at once; animate height and width changes **120 ms** (ease-out). Same text as before: ignored, and it does **not** restart the idle timer. |
| Idle fade | **1,800 ms** after the last *changed* text, fade out **250 ms** (ease-in), then `orderOut` and drop the text. (The server sends about one partial per 700 ms, so about two partials with no new words fades it.) |
| New text during the fade-out | Cancel the fade, fade back in **80 ms**, restart the timer. |
| Final | Show at 96% alpha for `1,500 + 100 × max(0, words − 8)` ms, at most **3,000**, then fade out 250 ms. |
| New partial while a final shows | A new utterance: replace the final with the partial (72%) at once, no stacking. Ignore partials that arrive within **400 ms** after a final (a late in-flight reply). |
| Claude starts speaking (`phase.json` = "speaking") | Fade out **200 ms**, but not before the final has been on screen at least **1,000 ms**. Partial or empty: at once. |
| Mic closes (`clear` message) | Fade out **200 ms**, drop the text. |
| Mute (`mute` file appears) | Fade out **120 ms**, drop the text, ignore partials and finals while muted. |
| Call ends / bubble exits | Nothing to do (process exits). |
| stdin closes (server gone, or another server owns the bubble) | Hide and keep working as today; no text ever shows. |

Implementation: one `DispatchWorkItem` for the idle or final-hold deadline (cancelled and recreated on each
change). Do not use the 30 fps timer for this; animate with `NSAnimationContext.runAnimationGroup`
(`allowsImplicitAnimation = true`) on the window's `alphaValue` and frame. No CPU while hidden.

### Input

Read stdin on a background queue (`FileHandle.standardInput.readabilityHandler`), split on `\n`, parse each
line with `JSONSerialization`, dispatch to main. Skip all of it when `isatty(0) != 0`. Ignore a line longer
than 8 KB, bad JSON, or an unknown `type`. Keep at most the latest text; the bubble stores nothing and
writes nothing.

### Accessibility

- **Reduce Motion** (`NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`): no slide, no size
  animation, no alpha change on partial to final; fades become **100 ms** cross-fades (opacity only).
- **Increase Contrast** (`accessibilityDisplayShouldIncreaseContrast`): glass becomes solid `#1C1C1E` at 95%;
  hairline becomes 1 pt white at 55%; partial text 85%, final 100%.
- **Reduce Transparency** (`accessibilityDisplayShouldReduceTransparency`): replace the glass with solid
  `#2C2C2E`.
- Re-read all three on `NSWorkspace.accessibilityDisplayOptionsDidChangeNotification` (no restart).
- **VoiceOver: no announcements, ever, in v1.** Reasons: VoiceOver's own voice would be picked up by the
  open mic and collide with the user's speech and with Claude's spoken reply seconds later. Partials
  rewrite themselves, so they would be spoken as noise. The text field is exposed as a static text with label
  "Live transcript" (`setAccessibilityLabel`) and its value updated, so a VoiceOver user who moves to it
  reads it on demand; no `NSAccessibility.post(.announcementRequested…)`. Hidden panels (`orderOut`) are
  not in the accessibility tree, which is correct.
- **Focus.** The panel never becomes key or main, never calls `NSApp.activate`, and is click-through, so
  keyboard focus and typing in the user's app are untouched.
- Text is not selectable and not copyable (it is transient). Claude's terminal already shows the final.

### States

| State | On screen | Text | Trigger out |
|---|---|---|---|
| **Hidden** (start, silence, no words heard, muted, Claude speaking, mic closed) | nothing, window ordered out | none | first non-empty `partial`/`final` |
| **Partial** | panel, 72% text, grows with text | newest tail of the latest partial | new partial (stay), `final`, idle 1.8 s, `clear`, mute, speaking |
| **Final** | panel, 96% text | the final text, tail-fit | 1.5 to 3 s hold, new utterance, `clear`, speaking (after ≥ 1 s), mute |
| **Fading out** | opacity 100% to 0 over 250 ms (200 ms on clear/speaking, 120 ms on mute) | frozen | done: Hidden; new text: Partial |

A noise-only utterance (cough, door) produces no partial and no final, so nothing ever shows ("no words
heard" is the Hidden state). A transcript that cleans to empty shows nothing.

### Edge cases

- Pill dragged to a screen edge or corner: the side and clamp rules above; the panel is never off-screen.
- Pill on a second display, or the display disconnected mid-call: use the pill's screen, else main.
- Menu bar auto-hide or a full-screen app: `visibleFrame` and `.fullScreenAuxiliary` handle it.
- Very long single word (URL read aloud): wraps by character; the tail fit still applies.
- Text arrives while the pill is being dragged: the panel follows; no flicker (child window).
- Emoji or non-Latin text: the system font cascades; line height stays 20 (min/max set).
- 150 ms scripted burst of partials: the swap is cheap (one string, one measure); no queueing.

### Review checklist (UX Designer, from code and a scripted run, no mic)

Run the bubble with a temp `VOICE_MCP_CACHE_DIR` holding a `call.json` whose `pid` is a live process, pipe
the JSON lines with `sleep` between them, and screenshot the panel. Check: appears only on text; side flips
at a screen edge; 3-line tail fit with leading `…`; 72% to 96% on final; fades at 1.8 s and after the final
hold; hides on `clear`, mute and "speaking"; Reduce Motion, Increase Contrast and Reduce Transparency each
change what this section says; clicking where the panel is hits the window underneath; the front app keeps
keyboard focus throughout.

## Performance budget

Measured by the Voice Performance Tester with a scripted (file-fed) recorder and the real `whisper-server`,
no mic or speakers:

- Final transcript latency (end of speech to final text): no more than 50 ms worse at the median than with
  live transcript off; the worst case is at most one partial inference.
- Extra CPU while talking: reported (whisper-server busy time per second of speech).
- Time from a word being said to it showing: reported.

## Privacy

- Partial words exist only in memory, in the server and the bubble. Nothing new is written to disk (the call's
  existing per-utterance WAV and inbox are unchanged). Nothing leaves the Mac: `whisper-server` listens on
  127.0.0.1 and the bubble is a local child process.
- Not logged, not even with `VOICE_MCP_DEBUG`. The flight recorder records at most counts and timings
  (`partials`, `partialMs`), never text.
- The bubble writes nothing; it drops the text when the panel hides.
- Privacy Reviewer sign-off before this is called done.

## Acceptance

- With the bubble running and a call on, a scripted utterance produces at least one `partial` line and then
  one `final` line on the bubble's stdin, in order; a cough-only utterance produces none.
- No partial while the last 300 ms were quiet; never two partial requests at once; stale replies dropped.
- `VOICE_MCP_LIVE_TRANSCRIPT=0`, the bubble off, or no whisper-server: no partial requests at all.
- No new files are created during a call with live transcript on (test lists the cache and temp folders).
- Partials never reach the inbox or the tool results.
- The Swift panel shows partial and final text per the UX section, fades on time, hides at mic close, does
  not take focus or clicks (the bubble's existing behaviour), and respects Reduce Motion. `swiftc` build
  check passes; visual behaviour is reviewed by the UX Designer from code and screenshots of a scripted run.
- Performance budget met, with numbers.
- `docs/` and CHANGELOG updated. `npm test` passes.
