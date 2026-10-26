# Development

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

```bash
npm install
npm test               # build + unit tests, end-to-end tests over MCP with stub binaries, and release-metadata checks
npm run audit          # known-vulnerability and signature checks on dependencies
npm run setup          # check what's installed; offers to install what's missing
npm run test:voice     # one real speak → listen → transcribe turn
npm run doctor         # objective self-check on this Mac: PASS / WARN / FAIL per stage, JSON report
npm run test:local     # the full server on this Mac's speakers and mic, with speed and memory numbers
npm run dev:plugin     # try this checkout in Claude Code as the "mac-voice-mcp-dev" plugin
npm run inspect        # MCP Inspector
```

## Testing on your Mac before a merge

CI has no speakers or mic, so it runs everything against stub binaries. Before merging anything that touches audio, timing or the protocol, run the real thing:

```bash
npm run test:local                       # this checkout
npm run test:local -- --compare 0.7.0    # side by side with a published version
```

It packs this checkout and installs it the way npm users get it, starts the server, and talks to it over MCP as Claude does. The voice turns run by themselves: while the server listens, the script says a known sentence through the speakers and scores the transcript. It also checks speak-only replies, typing to interrupt, and cancelling. It prints a table of install time and size, startup, reply time after you stop talking, transcription time, word errors, and memory and CPU use, and saves it to `local-test-results/`.

Turn the volume up, keep the room quiet, and stop voice mode in other sessions while it runs. It uses the settings in your shell, not your Claude config, so set the ones you use, for example `VOICE_MCP_VOICE="Voice 4" npm run test:local`.

| Module | Responsibility |
|---|---|
| `config.ts` | Environment settings, logging, the PATH fix-up for GUI apps |
| `speech-text.ts` | Rewriting screen text for speech, cleaning up transcripts (pure, unit-tested) |
| `endpointer.ts` | Turn-taking voice-activity detection (pure, unit-tested) |
| `audio.ts` | Text-to-speech, chimes, streaming mic capture |
| `kokoro.ts`, `kokoro-worker.ts` | The optional Kokoro voice: install, a warm worker process, sentence-by-sentence playback, fallback |
| `kokoro-text.ts`, `pcm.ts` | Pronunciation fixes and sentence chunks for Kokoro, PCM conversion (pure, unit-tested) |
| `model.ts` | Finding, symlinking or downloading the model |
| `stt.ts` | The warm `whisper-server` with orphan guard, and the `whisper-cli` fallback |
| `setup.ts` | Requirement checks and consent-based background installs |
| `lock.ts` | One voice turn at a time across every session on the Mac |
| `mcp.ts` | A small MCP server over stdio: JSON-RPC, tools, prompts, progress, cancellation |
| `voice.ts`, `server.ts`, `index.ts` | The round trip, the MCP tools and prompts, and the CLI |
| `skills/`, `hooks/` | The Claude Code plugin's `/mac-voice-mcp:talk` and `:setup` commands, the `voice-help` skill, and the stay-in-voice hook |

The package installs two commands: `mac-voice-mcp` (the one `npx -y mac-voice-mcp` runs), and `voice-mcp`.

## Testing changes

 Three layers; none of them depend on anyone's ears.

1. **`npm test`** runs everywhere, with stub binaries. It covers the MCP tools, turn-taking, setup, the mic lock, the plugin hook and the release metadata.
2. **The "Speech round trip" CI job** runs on a real Mac. Our own `setup --install` puts in SoX, whisper.cpp and the model. Then `doctor --no-loopback` runs, and `test/roundtrip.test.mjs` speaks known sentences with the real voice and transcribes them with the real whisper.cpp. The build fails if too many words come back wrong or transcription is too slow. The same job then installs the Kokoro voice with `setup --kokoro` and repeats the round trip with it, which also checks how soon Kokoro starts talking. GitHub's Macs have only basic voices and no GPU for whisper.cpp, so the limits there are looser: it guards against breakage, and doctor on a real Mac is the quality bar. The numbers are kept as a build artifact.
3. **`npm run doctor`** on your own Mac adds the one thing CI can't test, your speakers and microphone. It plays a sentence through the speakers, records it and transcribes it. Each stage gets PASS, WARN or FAIL against fixed limits, and the report is saved under `~/.cache/mac-voice-mcp/doctor/`.

## Trying the plugin from a checkout

 run `npm run dev:plugin`, then the `claude --plugin-dir …` command it prints. This loads a throwaway plugin, "mac-voice-mcp-dev", that runs this checkout's build with `node`. Its own name means it doesn't clash with an installed mac-voice-mcp. It also works inside this repo, where `npx mac-voice-mcp@<this version>` would find the checkout instead of the package and fail with `CONNECTION_CLOSED`.

## Releasing

- **First release:** `bash publish.sh`. It asks before each public step and uses your own GitHub and npm logins. It creates the GitHub repo, publishes to npm, and lists the server in the [official MCP Registry](https://registry.modelcontextprotocol.io), which Smithery, Glama, PulseMCP and mcp.so pick up from.
- **Later releases:**
  1. Add a section to `CHANGELOG.md` for the new version, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, dated today.
  2. Run `npm version patch` (bug fixes), `npm version minor` (new features) or `npm version major` (breaking changes), per [semver](https://semver.org). It updates `package.json`, `package-lock.json`, `server.json` and the plugin (including the npm version the plugin runs), commits, and tags `v<version>`.
  3. Run `git push --follow-tags`.

  The Publish workflow then runs the tests, which also check that every version and the changelog entry match. It publishes to npm with provenance, lists the release in the MCP Registry, and creates a GitHub Release from the changelog section. It needs no secrets: npm and the registry both use GitHub's OIDC identity, once you've set the package's *Trusted Publisher* on npmjs.com (`publish.sh` prints the steps). If a step fails, fix the cause and use **Re-run failed jobs**. Steps that already finished are skipped.
