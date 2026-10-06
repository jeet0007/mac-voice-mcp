# Voices

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

mac-voice-mcp speaks with one of two engines:

| Engine | Sounds | Setup |
|---|---|---|
| **macOS voices** (`say`) | Fine with a Premium voice, robotic with the default one | Built in |
| **Kokoro** (optional) | Close to a person | One-time install, about 1 GB on disk |

Once Kokoro is installed it's used automatically, and the macOS voice becomes the fallback.

## macOS voices

**Get a better voice (recommended).** macOS includes free Premium voices that sound far more natural than the default. Open **System Settings → Accessibility → Spoken Content → System Voice → Manage Voices…**, and download one, for example English → *Ava (Premium)* or *Zoe (Premium)*. The next voice turn uses it automatically. To choose a specific voice, or keep the system voice, see `VOICE_MCP_VOICE` in [Configuration](configuration.md#speaking). `VOICE_MCP_VOICE=default` always uses the voice chosen in System Settings.

## The Kokoro voice (optional)

[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) is a small neural voice that sounds close to a person and runs entirely on your Mac. Ask Claude to *"install the Kokoro voice"*, or run `npx -y mac-voice-mcp@latest setup --kokoro`.

- **What it installs:** [kokoro-js](https://github.com/hexgrad/kokoro) with npm into `~/.cache/mac-voice-mcp/kokoro/`, and the model from Hugging Face, once. That's about 1 GB on disk, and nothing is bundled with this package.
- **How it's used:** once it's installed, every turn uses it, starting with `af_heart`. Pick another voice with `VOICE_MCP_KOKORO_VOICE` (see [Configuration](configuration.md#speaking)). It speaks sentence by sentence, so it starts talking before the whole reply is generated. Each turn's timing line shows how soon the first sound came.
- **It can't leave you without a voice.** If Kokoro fails for any reason, the built-in voice takes over mid-sentence, and Claude tells you once.
- **To stop using it:** set `VOICE_MCP_TTS=say`, or delete `~/.cache/mac-voice-mcp/kokoro/`.
- **Limits:** English only (American and British voices). It speaks with its own pronunciation rules, which handle common developer words (JSON, `index.ts`, version numbers).

**Licenses.** The Kokoro model and kokoro-js are Apache-2.0. kokoro-js turns text into sounds with a WebAssembly build of espeak-ng (GPL-3.0), through the `phonemizer` package. None of this is part of mac-voice-mcp (MIT); it's installed on your Mac only if you ask for it. See [Third-party software](../README.md#third-party-software).
