# Call audio probe

Migration step 1 of the call audio redesign (`docs/specs/call-audio-redesign.md`): measure the risky parts
before any code moves. Nothing here ships in the npm package.

- `aec-worker.swift` is a prototype of the native audio worker with the planned protocol. One macOS
  voice-processing unit owns the mic and the speaker. It has no speech detection and no rules.
- `probe.mjs` runs the worker against the real `Endpointer` and the real whisper-server client from `dist/`,
  and prints a pass/fail table.

## Run it

Needs macOS with the Xcode command line tools (`swiftc`). The probe builds the worker and `dist/` itself.

```sh
node scripts/probe/probe.mjs --self-test    # no person needed, about 15 s, plays two short tones
node scripts/probe/probe.mjs                # every gate, about 4 minutes, needs you for the first two
node scripts/probe/probe.mjs --no-human     # gates d to h only
node scripts/probe/probe.mjs --only f       # one gate; also --skip a,b and --report FILE
```

Use laptop speakers at normal volume, no headphones, in a quiet room. Gates a, b and c prompt you with a
countdown: first to stay quiet while it talks, then to talk over it three times. In gate a, start talking
when it beeps and prints `NOW: TALK`.

The table goes to stdout. The numbers behind it go to `scripts/probe/.build/report.json`
(`self-test-report.json` for the self-test). The exit code is 1 if any row failed.

## The gates

| Gate | Question | Passes when | Needs you |
|---|---|---|---|
| a | How long from your first sound to the reply getting quieter, with speech detection in Node? | Under 200 ms from the first voiced frame reaching Node to the worker's ack of the gain command, in each of 3 heard tries. A try with no voice, or an onset under 150 ms after the beep (too soon to be you), is retried, up to 6 attempts | yes |
| b | Does it interrupt itself when it starts talking with no calibration? | 0 false onsets in the first 5 s of playback | quiet |
| c | Does it interrupt itself during a long reply on this output? | 0 false onsets from 5 s to the end of the reply. Also reports echo residue, the uncancelled level and the room level in dB, and the output name | quiet |
| d | Can whisper-server run a partial while a final runs? | A partial sent 50 ms after a final comes back in under 1000 ms, and none fail | no |
| e | Is `say -o` to PCM through the worker as fast as the standby `say`? | Text to first sound at the mic: the best PCM path is within 200 ms of standby `say` | no |
| f | Does the unit make other apps quieter, and does the ducking setting work? | The setting is accepted and `max` ducks at least 3 dB more than `min` | no |
| g | Does a Bluetooth headset switch to its call profile? | Report only: device sample rates before and after the unit starts. Skipped when the route is not Bluetooth | no |
| h | Does a worker started from Node get the mic? | Permission is `authorized` and the frames are not all zeros | no |

The self-test also checks that gate a's beep is not taken for a voice, and runs gate a with a tone instead of a voice: with echo cancellation off, the worker's own
tone is "someone talking". It is the same path (worker frames, Endpointer, gain command, ack).

### Reading the numbers

- **a.** The Endpointer needs 4 voiced frames (120 ms) before it calls it speech, so about 90 ms of the
  number is that rule and cannot shrink. Not counted: the time sound spends in the unit before Node sees the
  frame, and the output buffer after the ack. The self-test reports `playToFirstVoicedMs`, a full trip from
  play command to the mic frame in Node, as a bound on both.
- **b and c.** An onset is the Endpointer starting an utterance. In the redesign every onset while a reply
  plays makes the reply quieter and starts a word check, so each false one is a self-interruption risk.
- **d.** 1000 ms is this probe's number, not the spec's. The word check runs 700 ms after onset. If a
  partial waits for a whole final first, the reply stays quiet with no decision for that long.
- **e.** The mic is the stopwatch, so both paths carry the same detection delay.
- **a, the cue.** The beep plays through the worker, so echo cancellation removes it, and the Endpointer
  ignores it the way a call ignores its own chime. The report lists each missed attempt and your reaction
  time after the beep. An onset from echo that comes later than 150 ms still counts as you: compare with
  `onsetsBeforeTheCue`, the onsets heard during the countdowns.
- **f.** The meter is the unit's own mic with processing bypassed. The reference is the same tone played by
  the unit itself. A few dB of the difference may be the two playback paths and not ducking. Differences
  between levels are solid. `min` is measured again after `max`, so a level that only drifts with time
  cannot pass. "advanced" ducking only ducks while someone talks, and nobody talks in this gate.
- **f, second row.** A `rec` that was already recording when the unit starts. Report only.

## Worker protocol

Documented at the top of `aec-worker.swift`. In short: JSON lines on stdin (`play`, `pcm`, `end`, `gain`,
`pause`, `resume`, `stop`, `aec`, `agc`, `duck-others`, `info`), raw 16 kHz mono 16-bit mic audio in 30 ms
frames on stdout, JSON line events on fd 3 (`ready`, `devices`, `pos`, `done`, `ack`, `error`, `mic-closed`).
Closing stdin stops it.

Differences from the sketches in the spec, added for the probe: every command can carry `seq` and gets an
`ack`; `play` takes a sample rate; `pause`, `resume`, `aec`, `agc`, `duck-others` and `info` exist.
