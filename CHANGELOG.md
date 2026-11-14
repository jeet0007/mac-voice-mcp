# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Distinct sounds for each moment of a turn.** A soft tick means the mic is open, a pop means it heard you, a low purr means it heard nothing, and a low thud means something is wrong. `VOICE_MCP_CHIME=0` turns the tones off.
- **When voice can't work, you hear why.** If the mic is blocked, there's no recorder or speech engine, or the model is missing or still downloading, voice-mcp says one short line out loud, once, and Claude explains the fix on screen. `VOICE_MCP_SPOKEN_ERRORS=0` turns the spoken lines off.
- **A live transcript panel on calls.** While you speak, the call bubble shows what voice-mcp has heard so far in a small panel, so you know your words arrived before Claude answers. The panel never takes focus, fades about 1.5 to 2 seconds after your last words, and is hidden from screen sharing and recording. It lives in memory on your Mac: nothing is written to disk and nothing is sent anywhere. It works in calls only, with the call bubble and the warm whisper server. The `base.en` model is recommended: words reach the panel in about 230 to 310 ms, against about 480 to 530 ms with `small.en`, and your final transcript isn't slowed. `VOICE_MCP_LIVE_TRANSCRIPT=0` turns it off.
- **A flight recorder, off by default, to find out why a turn went wrong.** Set `VOICE_MCP_FLIGHT_RECORDER=on` and voice-mcp keeps a log on your Mac of what each turn decided: timings, audio levels and why a turn ended. It holds numbers and reasons, never what you or Claude said, only how long it was. It is kept for 7 days (`VOICE_MCP_FLIGHT_DAYS`) and is never sent anywhere. Details in [Privacy and security](docs/privacy-security.md).
- **Flag a moment.** Say a turn went wrong and Claude can save the last minute to a file on your Mac with the new `flag` tool; or run `mac-voice-mcp flag "what happened"` yourself. `mac-voice-mcp flight status` shows what is kept and `mac-voice-mcp flight purge` deletes all of it.
- **Optional audio.** `VOICE_MCP_FLIGHT_RECORDER=audio` also holds the last 30 seconds of mic audio in memory (`VOICE_MCP_FLIGHT_AUDIO_SECONDS`). It reaches the disk only when you flag a moment, and is gone when voice-mcp stops. `doctor` says when the recorder is on.

### Changed
- **One greeting when a call starts, not two.** Starting a call no longer says "I'm here." itself; Claude greets you once, in a few words. The plugin's hooks and Voice Buddy never spoke a greeting.
- **Replies are transcribed as soon as you stop talking.** voice-mcp no longer waits for the mic to close before it starts transcribing. The audio stays in memory instead of a temporary file.
- **The Kokoro voice is loaded when a call starts and while you talk,** so a reply doesn't start with a cold voice.
- **A mic that's busy in another window stays silent.** voice-mcp no longer speaks over it.
- **`voice_setup` gives a friendlier report.** It explains the mic permission prompt and what each sound means, and after an install it says once, out loud, that voice is ready.

### Fixed
- **Typing in another Claude window no longer stops this window's speech.** Voice Buddy's stop request now says which session typed, and each voice-mcp only listens to its own once it knows which window it belongs to: after its first voice turn, with listening while Claude works on (the default), or once a call starts. Before that, or with `VOICE_MCP_LISTEN_WHILE_WORKING=0`, any window's typing still stops it, as before. An older Voice Buddy still works as before. Already have it? Run `/plugin marketplace update mac-voice-mcp`, then `/reload-plugins`.
- **A stuck Kokoro voice no longer means silence.** If the Kokoro voice makes no sound for 30 seconds (`VOICE_MCP_KOKORO_STALL_SECONDS`), voice-mcp resets it and the built-in voice finishes the reply.
- **Claude is told when a long reply was shortened.** If the text to speak runs over 120 words, Claude is told how much was spoken and to make sure the rest is on screen.
- **Claude is told when lines were left out of what you said** (in `speak_and_listen` turns). Speech-to-text sometimes invents lines such as "Thanks for watching". They are still left out, and Claude is now told which, so it can ask you if something looks missing.
- **Real sentences that start with "Translated" or "Transcription" are no longer dropped.** Only a credit line such as "Transcription by …", or one that is your whole reply, is left out.
- **Short answers like "yes" are no longer thrown away.** A one-word reply is only about 0.2 s of speech, and voice-mcp used to treat anything under 0.3 s as noise. It now keeps sounds of about 0.2 s or more; a click or a cough of 0.15 s or less is still ignored.
- **The 30-second talking limit counts from your first word.** It used to start when the mic opened, so a slow start left you less time. `listen_seconds` is now how long you may talk. A stuck mic is still cut off after the wait for speech plus that limit.
- **Quiet, even speech is no longer cut off mid-sentence.** While you talk, voice-mcp now keeps its idea of the background noise well below your voice, so a soft, steady voice isn't mistaken for silence.
- **Fewer turns run on for 10 seconds after you stop talking.** Quiet sounds in the room, such as typing or someone talking across the room, kept the turn open when they were just loud enough to count, and the reply came 10–13 s after you finished. Once you are talking, voice-mcp now ignores sounds far quieter than your own voice (more than 18 dB below it). Speech that gets softer as you go is still kept, and so is speech after a loud start such as a cough: a quieter sound that goes on longer than the loud part becomes your voice level. After a very short answer such as "yes", on-and-off room sounds can still hold the turn open, as before. Known limits: after a short answer and a pause of 1.5 s or more, a soft aside more than 18 dB quieter is dropped. Soft trailing words more than 18 dB below the sentence can be dropped too, and a loud start of 1.5 s or more still loses the soft speech after it. Room sounds a second or so apart that each come a little quieter than the last can still hold the turn open, as before: each one counts as your voice and lowers the level the next one is measured against.
- **Words said over the "mic open" tick are kept.** If you start talking while the tick is still playing, the turn now starts where you did instead of after the tick, so your first words still reach the speech-to-text.
- **`npm run test:local` checks the real tool list.** It read only `speak_and_listen` and `voice_setup` and failed on every newer tool; it now reads the tool list from `src/server.ts`. Its test speaker also waits for the tick, as a person would, so the first words aren't lost.

## [0.9.0] - 2026-11-03

### Added
- **The call bubble (macOS, optional).** A small floating window shows while a call is on, above every app and on every desktop: Claude's blob, the call's duration, a mute button and a hang-up button. Click the blob to bring the call's terminal or editor to the front; drag it anywhere and it stays there. It never takes focus. It's built on your Mac from source with `swiftc` once you agree (`setup --bubble`, or `voice_setup` with `bubble=true`), needs Xcode's Command Line Tools, and rebuilds by itself after an upgrade. `VOICE_MCP_CALL_BUBBLE=0` turns it off. Without it, calls work as before.
- **The call bubble glows with your mic's level.** A soft glow around the pill grows as you speak louder: blue when voice-mcp hears it as speech, grey when it's too quiet to count (or just background noise). It goes away while you're muted and while Claude speaks.
- **Voice Buddy shows a muted call** as "Muted", so it agrees with the bubble.

### Changed
- **Voice Buddy 0.3.0 is a one-line status, without its animated blob.** The call bubble shows Claude's blob, and the terminal no longer redraws an animation 12 times a second. Already have it? Run `/plugin marketplace update mac-voice-mcp`, then `/reload-plugins`.

## [0.8.1] - 2026-11-03

### Changed
- **The voice is your system voice.** voice-mcp now speaks with the voice chosen in System Settings → Accessibility → Spoken Content → System Voice, instead of picking the most natural Premium or Enhanced voice installed. `VOICE_MCP_VOICE=best` brings back the old choice; a voice name still picks that voice.
- **The thinking tick on a call is off by default.** Up to six ticks after everything you said was too much. `VOICE_MCP_CALL_THINKING_SOUND=1` turns it back on.

### Fixed
- **What you say while Claude works no longer shows as a "hook error".** The plugin hands it to Claude as context on the next tool result instead of a blocking hook error, so Claude Code shows it as a note. (At the end of a turn it still has to block, so that one keeps the hook label.)

## [0.8.0] - 2026-10-31

### Added
- **Calls.** `/mac-voice-mcp:call` (or the `call` prompt in Claude Desktop and Cursor) keeps the mic open until you hang up, like a phone call, instead of one turn at a time. Talk whenever you like: while Claude works, your words reach it at its next step; while it waits, Voice Buddy hands them over as your next message, in about 0.15 s. Silence never ends a call (it ends after 30 minutes with nothing said, `VOICE_MCP_CALL_IDLE_MINUTES`). Hang up by saying "hang up" or "bye Claude", with `/mac-voice-mcp:hangup`, or by closing the session. Typing doesn't end the call or cut Claude off. While a call is on, voice in other windows says so instead of opening the mic. New tools for this: `call`, `say` and `listen`; `speak_and_listen` is unchanged.
- **Talk over Claude on a call, with headphones.** When the Mac's sound goes to headphones, the mic stays open while Claude speaks. A quarter second of your voice pauses Claude. Say something real and the rest of its reply is dropped, and Claude hears what you said and roughly how far it got. A filler such as "mm-hmm", a cough, or nothing real within 2 s lets it carry on from where it paused. On speakers the mic stays muted while Claude speaks, as before. `VOICE_MCP_CALL_DUPLEX` (`auto`, `full`, `half`) overrides the headphone check.
- **No dead air on a call.** After your words reach Claude, a soft tick plays every 1.5 s until Claude speaks, for up to 10 s (`VOICE_MCP_CALL_THINKING_SOUND=0` turns it off). When Claude Code shows a permission prompt during a call, Claude says "Claude needs your OK on screen" (a new Notification hook in the plugin), so the call doesn't stall silently.
- **Voice Buddy shows a call.** The calling window's buddy turns bright green and shows how long the call has lasted; it still turns orange and blue while Claude speaks and listens.
- **Voice Buddy 0.2.0.** Needed for the best calls: it's what hands your words to Claude while it waits. Already have it? Run `/plugin marketplace update mac-voice-mcp`, then `/reload-plugins`.

## [0.7.1] - 2026-10-26

### Changed
- **One runtime dependency instead of 95.** voice-mcp now speaks MCP over stdio with its own small server (`src/mcp.ts`) instead of `@modelcontextprotocol/sdk`, whose runtime also installs an HTTP server stack (express, hono, cors and others) that a stdio server never runs. The only runtime dependency left is zod, which has none of its own. The tools, prompts and instructions clients see are unchanged, and the tests still drive the server with the official SDK client. This clears most of the supply-chain alerts that scanners such as Socket raised about packages voice-mcp never used.
- **Installs and starts faster, with less memory.** Measured on a Mac against 0.7.0: install 5.8 s → 0.9 s (cold npm cache), startup 82 → 51 ms, and the server's idle memory 76 → 63 MB. Speaking, listening and transcribing take the same time as before.

## [0.7.0] - 2026-10-23

### Added
- **Voice Buddy (Claude Code), a new optional plugin in the same marketplace:** `/plugin install voice-buddy@mac-voice-mcp`.
  - **An animated buddy above the prompt** shows what the voice is doing in that window: orange while Claude speaks, blue while it listens, purple while it transcribes, grey while it waits for another voice session, green while it listens for "Claude, …". Coloured blocks in the terminal, a smooth animated shape in the desktop app and VS Code. Inspired by [animated-blobs](https://github.com/xom9ikk/animated-blobs).
  - **Type to interrupt.** Your first keystroke during a voice turn stops Claude talking and listening at once, instead of your message waiting up to 15 seconds for the turn to end, and Claude waits for what you type. It also stops a spoken update that's still playing and listening while Claude works, for your own window only. It's a Claude Code mod (early-access API); if it ever can't stop the voice it says so once, and without it Esc still interrupts.
- **voice-mcp stops a voice turn when asked to:** a `voice-mode/stop` file (`{"at": <ms>}`) written during a turn stops the speech and the mic within about a tenth of a second, and Claude is told the user started typing. This is what Voice Buddy writes.

### Changed
- **`voice-mode/phase.json` is now written by default** (it was opt-in with `VOICE_MCP_PHASE_FILE=1`), for Voice Buddy. `VOICE_MCP_PHASE_FILE=0` turns it off.

## [0.6.1] - 2026-10-23

### Changed
- **Replies start sooner with the built-in voice.** macOS loads the voice each time it speaks, which takes about 1.4 s with a Siri voice before the first word. Now, after your first voice turn, the voice is started ahead of each reply and waits for the text. With Siri Voice 4, the wait beyond the speech itself fell from 1.4 s to 0.6 s on 8 test replies. `VOICE_MCP_VOICE_STANDBY=0` turns it off.
- **No stop after "Okay."** A one-word opener now runs into the next sentence ("Okay, this is what I found…"): voices pause after a full stop, and after a one-word sentence it stands out. With Siri Voice 4, the longest pause in such replies fell from about 0.5 s to 0.3 s on average.
- **No more silence in the middle of a Kokoro reply.** Kokoro speaks a reply piece by piece, making the next piece while one plays, and a short first sentence followed by a long one ("Sure." then a long explanation) left the speaker waiting. Now the first piece is the first sentence or clause, and each piece is at most three times longer than the one before, so it's always ready in time. On 12 typical replies on an M-series Mac: replies with a pause went from 2 to 0 (the worst pause was 1.4 s), and the first sound still comes after about 0.65 s.
- **Fewer cut-offs while you think: your turn now ends after 1.5 s of quiet instead of 1.2 s.** On 10 recorded explanations, spoken naturally with thinking pauses of up to 1.5 s, 1.2 s cut 3 of them off mid-thought and 1.5 s cut off none. Replies start 0.3 s later. `VOICE_MCP_END_SILENCE_MS` still sets it.
- **The talk skill asks Claude not to send a separate "Okay" before its answer,** since each voice message takes a moment to start.
- **Dependencies:** hono 4.13.13 (via the MCP SDK; it includes a fix for [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) in static file serving, which this server never uses) and zod 4.6.6.

## [0.6.0] - 2026-10-13

### Added
- **Voice mode keeps talking while long work runs (Claude Code plugin).** With `/mac-voice-mcp:talk`, Claude does quick things itself and hands anything longer (test runs, builds, research) to a background agent, then goes straight back to listening, so you can keep talking while the work happens. When the agent finishes, Claude tells you the result by voice. If you go quiet in the meantime, it says "Still on it" once instead of asking again every few seconds.
- **`VOICE_MCP_PHASE_FILE=1`** writes what a voice turn is doing (speaking, listening, transcribing, waiting) to `voice-mode/phase.json`, for a status display of your own. Off by default.

### Changed
- **A spoken update no longer holds Claude up.** `speak_and_listen` with `listen: false` ("Give me a few minutes") now returns at once and speaks while Claude carries on. Each one used to block Claude's next step for the whole sentence: 7 to 12 seconds in real use, and 8.1 s down to 0.3 s for an 8-second sentence in a test. The next voice turn waits until it has finished, listening while Claude works resumes only once the speaker is quiet, and a voice that fails right away is still reported straight away (a later failure comes with the next result).

## [0.5.0] - 2026-10-12

### Added
- **Talk to Claude while it works (Claude Code plugin).** After you answer out loud, the mic stays open while Claude works. Say something that starts with its name, such as "Claude, use the other branch", and a soft sound confirms it was heard. Claude gets it after its next tool call, or as soon as it finishes, and takes it into account.
  - Only speech that starts with "Claude" is passed on. Everything else is transcribed on your Mac, checked for the name, and dropped. What's passed on waits in a file only your account can read, and is deleted once Claude has it.
  - It pauses while Claude speaks to you, and carries on after a quick update that doesn't wait for an answer ("Give me a few minutes"). It stops when you type, when Claude finishes, when voice mode ends, when another Claude window takes over, and after 10 minutes without a voice turn (`VOICE_MCP_WORK_LISTEN_MINUTES`). The mic closes within a quarter of a second, and macOS shows the orange mic dot while it's on.
  - What you say goes to the main Claude, not to a helper agent it started.
  - It needs the plugin's hook, so Claude Desktop and Cursor never keep the mic open. `VOICE_MCP_LISTEN_WHILE_WORKING=0` turns it off.
  - To hand over what you said, the plugin now runs a tiny shell check after every tool call: about 2 ms, and Node only starts when there is something to deliver.

## [0.4.2] - 2026-10-11

### Changed
- **Docs and the voice-help skill now suggest `small.en` for noisy rooms,** with measured numbers: on real recordings with background noise it got 8% of words wrong instead of 12% with `base.en`, the same in a quiet room, at about 0.3 s per reply. `base.en` stays the default, so nobody gets a 466 MB download they didn't ask for.

### Fixed
- **`doctor` explains a voice that produces no audio.** Sometimes macOS `say` finishes without error but writes almost no sound (0.1 s for a whole sentence), for example when a voice's speech data is missing. `doctor` used to report that as "0% of words right". Now it tries once more, then says which voice wrote no audio and how to pick another (`VOICE_MCP_VOICE`). This was also behind the speech round trip failing on some CI runs, which now use a fixed classic voice.
- **A cough or a fan no longer counts as your answer.** For a sound with no words, whisper writes a note like `[gunshot]` (a cough), `[APPLAUSE]` (typing) or `[sound of running]` (a fan), and those notes were passed to Claude as if you'd said them. Now every sound note is dropped, and Claude is told it heard a sound but no words. On 10 noise-only clips (cough, typing, fan, hum, music, a door, breathing, silence), all 10 now come back as no speech.
- **Sentences whisper invents from videos are dropped**, such as "You can find the link in the description below." or "Thanks for watching!". Only whole sentences that nobody says to a coding assistant; "Thank you." and "Bye." stay.

## [0.4.1] - 2026-10-10

### Added
- **README: a Disclaimer, a Third-party software table and a trademark note.** They spell out what the tool does on your Mac (mic, installs with your consent), that speech recognition can mishear, the license of everything it uses but doesn't bundle, and that the project isn't affiliated with Apple or Anthropic.

### Changed
- **whisper hears developer talk better.** In English it now gets a one-sentence hint that the conversation is a developer talking to a coding assistant. On 60 test clips read by three voices, word errors fell from 3.4% to 2.3% on everyday sentences and from 3.8% to 3.1% on developer jargon ("rebase", "backend"), and nothing was invented in silence. `VOICE_MCP_WHISPER_PROMPT` replaces the hint with your own, and `none` turns it off.
- **A shorter README, in the style of popular MCP servers:** what it's for, features, a four-step quick start and the most common fixes. The full guides moved to [`docs/`](docs/): install, voices, usage, configuration, troubleshooting, privacy and security, and development.

### Fixed
- **The first words of a reply were often lost.** The "mic open" chime played before the recorder had actually started, and opening a mic takes a moment (longer with Bluetooth), so anyone who answered right at the chime lost a word or two. In a test with 20 real recordings, 12 began mid-word, and the cut-off starts led whisper to mishear or invent the rest ("Open a draft PR…" came back as "You can find the link in the description below."). Now the mic opens first and the chime plays once audio is flowing; the chime's own sound is ignored. Re-recorded with the fix, 2 of 20 began mid-word, and whisper's word errors on that voice fell from about 20% to 5% (and from 28% to 12% with background noise).

### Security
- **MCP SDK 1.32.1** ([GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)). The advisory is in the SDK's OAuth client, which this server never uses (it only talks over stdio), but `npm audit` flagged every install.

## [0.4.0] - 2026-10-06

### Added
- **An optional natural voice: Kokoro.** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) is a small neural voice that runs on your Mac and sounds much closer to a person than `say`.
  - **Install it only if you want it:** `voice_setup` with `kokoro=true` (Claude asks first), or `npx mac-voice-mcp setup --kokoro`. It installs `kokoro-js@1.2.1` with npm into `~/.cache/mac-voice-mcp/kokoro/` and downloads the model once, about 1 GB on disk. Nothing is bundled, and speaking never downloads anything.
  - **Once installed it's used automatically**, with the `af_heart` voice. It runs in its own warm process and speaks sentence by sentence, so the first sentence plays while the rest is generated. The timing line shows how soon the first sound came.
  - **It can't leave you without a voice.** If Kokoro fails, the built-in voice says whatever hadn't been said yet, and Claude is told once.
  - **Settings:** `VOICE_MCP_TTS` (`auto`, `say` or `kokoro`), `VOICE_MCP_KOKORO_VOICE`, `VOICE_MCP_KOKORO_SPEED`, `VOICE_MCP_KOKORO_DTYPE` and `VOICE_MCP_KOKORO_DIR`.
  - **`doctor` and the CI round trip cover Kokoro too:** whisper must understand it, and the first sound must come quickly.
- **`doctor`: an objective self-check** (`npx mac-voice-mcp doctor`). It checks the whole pipeline on your Mac and marks each stage PASS, WARN or FAIL against fixed limits:
  - **Setup:** everything is installed.
  - **Speech → text:** the voice speaks a known sentence into a file, and whisper must get the words right.
  - **Speaker → mic:** the same sentence is played aloud and recorded. It catches mic permission problems, the wrong input device and headphones.

  Reports are saved as JSON under `~/.cache/mac-voice-mcp/doctor/`. Use `--no-loopback` to skip the speakers, and `--json` for machine-readable output.
- **A "Speech round trip" CI job on a real Mac.** It installs everything with our own `setup --install`, runs `doctor`, then speaks known sentences (everyday and developer jargon) with the real voice and transcribes them with the real whisper.cpp. The build fails on too many wrong words or slow transcription.
- **`npm run dev:plugin`** loads this checkout into Claude Code as a separate "mac-voice-mcp-dev" plugin. It runs the local build with `node`, with no npx and no clash with the installed plugin.

## [0.3.1] - 2026-09-29

### Fixed
- **Recording broke on Macs without SoX when Bluetooth headphones were connected** ([#6](https://github.com/jeet0007/mac-voice-mcp/issues/6)). Every turn failed with "pure digital silence".
  - The ffmpeg fallback now records from the input chosen in System Settings (`:default`) instead of device number 0. `VOICE_MCP_FFMPEG_DEVICE` still overrides it.
  - `voice_setup` treats ffmpeg as a fallback, recommends SoX, and installs it with your OK.
  - Silence recorded through ffmpeg now points at the input device and SoX, not only at mic permissions.
- **`voice_setup` notices tools installed since the last check**, such as `brew install sox` run in a terminal, without restarting the app.

## [0.3.0] - 2026-09-28

### Added
- **Voice conversations stay in voice (Claude Code plugin).** Once you've answered out loud, a plugin hook sends Claude back to reply by voice if it tries to answer in text. It does this at most once per spoken answer, so it can never loop. Voice mode ends when you type, when you don't answer, or when Claude says goodbye with `listen: false`. It's tracked per session and expires after 30 idle minutes. `VOICE_MCP_STAY_IN_VOICE=0` turns the hook off.
- **`speak_and_listen` with `listen: false`** speaks without opening the microphone, for one-way announcements or a goodbye. It needs only text-to-speech, not the recorder, whisper or a model.
- **One voice turn at a time across the whole Mac.** Claude Code windows, Claude Desktop and Cursor take turns at the speaker and mic, one turn at a time, so they never talk over each other. A waiting turn reports "waiting for another voice session" and gives up after `VOICE_MCP_LOCK_WAIT_SECONDS` (120) with a clear message. A lock left by a crashed session is taken over. If the cache folder isn't writable, turns go ahead without the lock.
- **README: an Upgrading section and a Voice mode section, plus a note on testing the plugin from a checkout.**

### Changed
- **Claude waits longer for you to start talking: 15 seconds, up from 8** (`VOICE_MCP_START_TIMEOUT_SECONDS`), so reading or thinking doesn't end the conversation.
- **When you don't answer, Claude asks once more, then pauses cleanly.** The "no speech" result now tells Claude that the mic is off, so it tells you to type to carry on rather than to speak.

### Removed
- The unused `packaging/` folder. `.github/` is the only copy of the workflows.

## [0.2.0] - 2026-09-28

### Added
- **A more natural voice, automatically.** On macOS, speech uses the best Premium or Enhanced voice installed for the spoken language, preferring your Mac's region, and otherwise the system voice. `voice_setup` shows which voice is in use and, if there's no Premium voice, how to download one for free in System Settings. `VOICE_MCP_VOICE=default` keeps the system voice.
- **A timing line on every turn.** Each `speak_and_listen` result ends with a line like `voice-mcp timing: spoke 3.1 s · listened 4.0 s (user talked 2.2 s) · transcribed 0.3 s`, which makes a slow turn easy to explain. The model is told to ignore it unless you ask.
- **Claude Code plugin commands and a skill:**
  - `/mac-voice-mcp:talk [task]` starts a voice conversation. It pre-approves voice turns while it runs.
  - `/mac-voice-mcp:setup` checks, installs with your OK, and tests.
  - The `voice-help` skill gives Claude fuller usage guidance and a troubleshooting table.
- **README: "Allow voice turns without prompts".** The `permissions.allow` entries that stop Claude Code from asking for approval on every voice turn.
- **Releases:**
  - `npm version patch|minor|major` now also updates `server.json` and the plugin.
  - Each tag creates a GitHub Release from this changelog.
  - Tests fail if any version, the plugin's pinned npm version or the changelog entry is out of sync.

### Changed
- **The plugin runs the exact npm release it ships with** (`mac-voice-mcp@0.2.0`), instead of whatever version npx cached first.
- **The README's install configs use `mac-voice-mcp@latest`,** so npx picks up new releases. This covers Claude Desktop, Cursor, VS Code and `claude mcp add`.
- **The publish workflow is safe to re-run.**
  - It skips npm and the MCP Registry when the version is already there.
  - It retries the registry while npm catches up.
  - It checks out without persisting credentials.

## [0.1.1] - 2026-09-23

### Added
- **README:** one-click install buttons for Cursor and VS Code, and install steps for the Claude Code plugin marketplace and the official MCP Registry.
- **Releases publish through npm trusted publishing, with provenance.**

### Changed
- **Node.js 22 or newer is now required.** Node 18 and 20 no longer receive security fixes. CI tests on Node 22, 24 and 26.

### Fixed
- **"It's on screen" when it isn't** ([#3](https://github.com/jeet0007/mac-voice-mcp/issues/3)).
  - When the spoken text sends you to look at something, the model is reminded that only its own message text reaches your screen, not the speech and not Bash/tool output. The speaking rules now say the same.
  - Thanks to Copilot for the first version ([#4](https://github.com/jeet0007/mac-voice-mcp/pull/4)).
  - The trigger phrases were narrowed so that ordinary sentences like "above thirty degrees" or "see the doctor" don't set it off.

### Security
- TruffleHog secret scanning, CodeQL, dependency review, `npm audit` in CI, and Dependabot.

## [0.1.0] - 2026-09-23

### Added
- First release:
  - `speak_and_listen`: natural turn-taking, with on-device whisper.cpp and a warm server.
  - `voice_setup`: checks first, installs only what's missing, and only after you agree.
  - The `setup` and `voice_mode` prompts.

[Unreleased]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jeet0007/mac-voice-mcp/compare/119a589...v0.1.1
[0.1.0]: https://github.com/jeet0007/mac-voice-mcp/tree/119a589
