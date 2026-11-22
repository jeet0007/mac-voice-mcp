# Listening

Source: `src/endpointer.ts`, `src/listen/utterances.ts`.

Listening decides when the user has started and stopped talking, and hands whisper just the words. It
runs with no model. `Endpointer` is a pure, unit-tested energy detector that adapts to the room's
background noise. `Utterances` is the one frame loop that feeds it mic frames. The thresholds the user can
set are in [configuration](../configuration.md): `VOICE_MCP_END_SILENCE_MS`,
`VOICE_MCP_START_TIMEOUT_SECONDS`, `VOICE_MCP_SPEECH_MARGIN_DB` and `VOICE_MCP_MIN_SPEECH_DB`.

## Frames

Audio is 16 kHz, 16-bit little-endian mono PCM in 30 ms frames (`FRAME_MS`). A frame is 480 samples, 960
bytes. Each frame's level is its RMS in dBFS, floored at -100. `wavHeader` writes the 44-byte header for
mono 16-bit PCM WAV, 16 kHz unless told otherwise.

## The endpointer

### Speech threshold

A frame is speech when it is louder than both `floorDb + marginDb` and `minSpeechDb`. The first 3 frames
(90 ms) are never speech, while the mic settles.

The background level (`floorDb`) is the quietest frame of the last 1.5 s (50 frames), clamped to -90 to
-30 dBFS. It keeps updating while the user talks, because the gaps between words are quiet. So it follows
a room that gets louder, such as a fan or a laptop mic's automatic gain boosting the noise after speech,
as well as one that gets quieter.

Once the user is talking, the quietest recent frame can be just a soft syllable. The floor may then rise
no higher than 24 dB below the voice (`FLOOR_CEILING_BELOW_SPEECH_DB`). Otherwise speech that only varies
a few dB from syllable to syllable is taken for background, and the next soft syllable counts as silence.

### Start and short sounds

Speech starts after 4 loud frames in a row (`ONSET_FRAMES`, 120 ms). The utterance then begins at the
first of those frames.

A sound that ends with fewer than 7 voiced frames (`MIN_UTTERANCE_MS`, 210 ms) is noise, such as a cough,
a click or a chair. The endpointer forgets it and keeps waiting. A real short answer like "yes" (about
200 ms) still counts. The bar is counted in whole frames, and a sound touches one more frame than its
length. A 150 ms cough can light 6 frames (180 ms), and a 200 ms "yes" lights at least 7. An earlier bar of
180 ms let the cough through about one CI run in ten (#48).

### Voice level and sounds far below it

`speechDb` is the running level of the user's voice. It starts at the onset frame's level and moves 10%
towards each voiced frame, so it follows speech that slowly gets softer.

Once the user is talking, a frame more than 18 dB below that level (`BELOW_VOICE_DB`) is not them. Typing
or someone across the room neither keeps the turn open nor drags the voice level down. Without this rule
a live run on 2026-11-14 had replies of 10.0 s and 13.4 s after the user stopped. `speechDb` ended at
-41.7 and -45.5 dBFS against -19.1 for the same sentence in another turn. Quiet room sounds just over
the -48 dBFS minimum counted as the user, reset the end-silence timer and pulled the voice level down to
the room's. Replaying those turns gave 8.6 s and 11.2 s before the rule and 2.0 s after. An 18 dB drop
in soft speech is still kept (#48).

There is one exception. If the quieter sound goes on for longer than the voice before it, and for at
least 17 frames (`REBASE_MIN_FRAMES`, about 0.5 s), the loud part was the odd one out. That could be a
cough, a mic bump or a loud first word. The quieter sound then becomes the voice. `speechDb` becomes its
mean, and its frames count as voiced, so speech after a loud start is not lost.

### End of turn

Once the user is talking, the turn ends on either of two signals.

- `endSilenceMs` of frames below the threshold.
- A whole end-silence window of steady sound clearly below the voice. Steady means a spread (standard
  deviation) under 2.5 dB (`STEADY_SPREAD_DB`). Clearly below means a mean more than 6 dB under
  `speechDb` (`STEADY_BELOW_SPEECH_DB`). Speech rises and falls with every syllable, and background
  noise does not. This ends the turn when the room gets louder after the user stops. The last voiced
  frame is then moved back to the start of that window, and the window's frames stop counting as voiced.

Either way the short-sound rule above applies first, so a turn never ends on a blip.

### Time limits

`maxMs` is how long the user may talk, counted from when they start. Before any speech, the endpointer
returns `no-speech` after `startTimeoutMs` (never more than `maxMs`). A hard cap of
`startTimeoutMs + maxMs` keeps a stuck mic from listening forever. The reasons are `end-of-turn`,
`no-speech` and `max-duration`.

### Ignoring the chime

While our own "mic open" chime plays, `setIgnoring(true)` stops the endpointer judging frames. They are
neither speech nor background, but time still counts.

Speech that is already going when the chime ends began under it. The endpointer remembers where the
unbroken sound still going at the end began. Gaps between words do not break it, and 10 quiet frames
(`OVER_CHIME_GAP_FRAMES`, 300 ms) do. If speech starts within 5 frames (`OVER_CHIME_SLACK_FRAMES`) of the
chime ending, the utterance starts where that sound began. The chime is loud too, so that is at most the
chime's start. Words said over the tick still reach whisper, and quiet before them does not.

### What it reports

`diagnostics()` gives the levels behind the last decision for tuning: the background level, the voice
level (NaN before any speech), and the mean and spread of the last second, all in dB. `anyNonZero` stays
false while every sample is exactly zero, which almost always means a blocked mic. `lastDb` and
`lastThresholdDb` drive the call bubble's glow ([call bubble](call-bubble.md)).

`trimRange` gives the frames worth transcribing: from the utterance's start to its last voiced frame,
plus 300 ms either side.

## The frame loop

`Utterances` turns frames into utterances. The audio stays in memory. Each utterance comes back as a
trimmed 16 kHz mono WAV, with leading and trailing silence cut and a little padding kept, so whisper gets
just the utterance. A turn listens for one utterance. A call cuts its open mic into utterance after
utterance until the session closes. The loop replaced per-mode loops in the audio input port (#63).

Its `onHeard` callback reports four events.

- `onset`: the user has talked for `BARGE_IN_MS` (250 ms). That is the bar for talking over Claude.
  Pipecat waits 200 ms and LiveKit 500 ms. 150 ms was too eager.
- `ended`: an utterance, with its reason and WAV.
- `blip`: speech cut before its onset, too short to count, so it is dropped.
- `no-speech`: nothing was said before the start timeout.

`onLevel` gets each frame's level and the threshold it was judged against, and `live` gets the frames for
the [live transcript](live-transcript.md).

### Echo frames

A frame marked `echo` is never judged or kept. The mic has stopped hearing the user: our reply is on the
speakers, or the mic is muted. The first echo frame ends what the user was saying, with the reason `cut`.
Everything said so far is all there is. Past the onset it is an utterance. Speech that began but had not
reached the onset is a blip (logged as `listen.cut`) and dropped. See [call audio redesign](call-audio-redesign.md).

When an utterance ends, the live transcript is ended before the utterance is reported. A partial still in
flight is dropped, and the final transcript goes alone.

### One turn

`listenForTurn` starts the recorder first and plays the chime only once 250 ms of audio has arrived
(`MIC_WARMUP_MS`). By then the recorder is running and the room's level is known. Opening a mic takes a
moment, longer with Bluetooth, so someone who starts talking right at the chime is never cut off (#12).
While the chime's promise is pending the endpointer ignores frames, and for 80 ms after, because the
chime's echo fades out of the mic a moment after it ends.

The turn stops the recorder the moment the user finishes, without waiting for it to exit (#44).
`session.close()` does that. A safety timer of the start timeout plus the talking time plus 5 s stops the
loop if the recorder stops delivering audio. If the recorder fails, what it heard so far is the turn. If
it delivered no audio at all, the turn throws, adding the macOS mic permission hint on macOS. An abort
throws `CancelledError`.

The result carries the reason (`max-duration` when the loop ended without one), whether the mic gave only
digital silence, the seconds of voiced audio, the diagnostics and the trimmed WAV. `listen.start` and
`listen.end` flight events record the settings and the outcome ([flight recorder](flight-recorder.md)).

### A call

`listenContinuously` runs until the session closes, with a fresh endpointer for each utterance. An
utterance is at most 60 s (`UTTERANCE_MAX_MS`), and the start timeout is the same 60 s. Silence never ends
the call. After 60 s of it the endpointer just starts afresh, so nothing piles up. It rejects if the mic
stops on its own. See [call mode](call-mode.md).
