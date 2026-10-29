# Call mode Phase 0: idle-delivery spikes

Throwaway. Decides which route delivers a spoken utterance into an idle Claude Code session
(docs/specs/call-mode.md, Delivery). Delete this folder once Phase 1 picks a route.

| Route | What delivers | Files |
|---|---|---|
| A | mod calls `$.session.send({ to: { sessionId: <own id> }, text })` (cross-session messaging socket, self-message) | `idle-mod/` |
| B | mod calls `$.prompt.submit({ text, asUser: true })` | `idle-mod/` |
| C | Stop hook waits for the next utterance and returns `{ decision: "block", reason: <utterance> }` | `stop-hook/` |

`drive.mjs` runs one route. For each of 20 utterances it waits until the session is ready (idle for A
and B, Stop hook waiting for C), stamps "end of speech", and writes the utterance to
`~/.cache/mac-voice-mcp/spikes/inbox.json`. Then it reads the session's transcript. "Turn start" is the
first `api-request` row after the utterance, the moment the model call goes out. An utterance counts as
delivered only once Claude's reply row appears (60 s timeout).

## Run

Use a spare folder so the spike session never shares a transcript folder with real work. Run each
route in its own fresh session, in a second terminal next to the spike session.

```sh
REPO=~/workspace/Personal/claude-voice
mkdir -p /tmp/call-spike && cd /tmp/call-spike

# A
claude -n spike-a --plugin-dir $REPO/scripts/spikes/idle-mod     # terminal 1, leave it idle
node $REPO/scripts/spikes/drive.mjs a --session spike-a          # terminal 2

# B
claude -n spike-b --plugin-dir $REPO/scripts/spikes/idle-mod
node $REPO/scripts/spikes/drive.mjs b --session spike-b

# C: start the driver first, then type "hi" in the spike session so its turn ends and the hook waits
claude -n spike-c --plugin-dir $REPO/scripts/spikes/stop-hook
node $REPO/scripts/spikes/drive.mjs c --session spike-c
```

If `--session <name>` doesn't match, use the pid. `ls ~/.claude/sessions` lists `<pid>.json` files, and
each one shows its `name`. Options: `--count 20`, `--timeout 60` (seconds per utterance).

Watch the spike session while it runs and note UI glitches: prompt box state, spinner, rows
labelled as a plugin or as a peer, and anything left in the box.

## Output

One line per utterance, then the summary:

```
route b: delivered 20/20; end of speech → turn start median 0.41 s, p90 0.60 s, max 0.92 s
```

The full log is `~/.cache/mac-voice-mcp/spikes/results-<route>-<run>.jsonl`. Each row holds:

- `startS`: end of speech to turn start, in seconds.
- `rowS`: end of speech to the utterance's transcript row.
- `replyS`: end of speech to Claude's reply.
- `rowType`: how the transcript stored the utterance.
- `ack`: what the engine answered (A and B), useful when an utterance was missed.

## What to look for

- **A.** `$.session.send` may refuse a message to its own session, or queue it without starting a turn
  (the docs say "delivered means queued"). Both show up as misses with the reason in `ack`.
- **B.** The prompt should run as a normal user turn. Check that a draft typed in the box survives.
- **C.** Claude Code caps consecutive Stop-hook blocks (the spec says 8). If the cap holds, C stops at
  about 8/20 with "NOT READY". While the hook waits, the session looks busy and typing queues behind it.

Each route polls at 100 ms (A and B) or 50 ms (C). That polling sits inside the measured latency, as it
would in Phase 1.
