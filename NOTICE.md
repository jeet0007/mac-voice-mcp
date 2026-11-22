# Disclaimer and third-party software

## Disclaimer

mac-voice-mcp is a free, open-source personal project. It's provided **as is, with no warranty of any kind**, and the authors aren't liable for any damage or loss from using it. See the [LICENSE](LICENSE) for the exact terms. In plain words:

- **It turns on your microphone** whenever an AI assistant calls `speak_and_listen`, and for the whole of a call, until you hang up. It plays sound through your speakers.
- **Speech recognition makes mistakes.** An assistant may act on a misheard word. Check what it heard before you let it do anything you can't undo, like deleting files, pushing code or sending messages.
- **It installs software on your Mac**, but only after you agree: Homebrew packages, and kokoro-js with npm if you choose the Kokoro voice. Those are separate projects, under their own licenses (below).
- **There's no guaranteed support.** Issues and pull requests are welcome, and fixed on a best-effort basis.

**Vibe-coded.** This project was designed and written with Claude, in conversation. A human steered it, tested it on a real Mac and checked the test suite, but most of the code was written by AI.

**Trademarks.** Apple, Mac, macOS and Siri are trademarks of Apple Inc. Claude is a trademark of Anthropic. mac-voice-mcp is an independent project, not affiliated with, sponsored or endorsed by Apple or Anthropic.

## Third-party software

mac-voice-mcp doesn't bundle any of these. It uses them when they're on your Mac, and installs them only with your consent. Each one comes under its own license.

| Software | Used for | License |
|---|---|---|
| [SoX](https://sourceforge.net/projects/sox/) | Recording from the mic, Kokoro playback | GPL-2.0 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Speech-to-text | MIT |
| [Whisper models](https://huggingface.co/ggerganov/whisper.cpp) (OpenAI) | Speech-to-text | MIT |
| [Silero VAD](https://huggingface.co/ggml-org/whisper-vad) model | Skipping silence before transcribing | MIT |
| macOS voices (`say`) | The built-in voice | Apple's macOS license |
| [kokoro-js](https://github.com/hexgrad/kokoro) (optional) | The Kokoro voice | Apache-2.0 |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model (optional) | The Kokoro voice | Apache-2.0 |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) (optional, inside kokoro-js) | Turning text into sounds for Kokoro | GPL-3.0 |
| [ffmpeg](https://ffmpeg.org) (fallback, never installed by setup) | Recording, if SoX is missing | LGPL-2.1 / GPL |
