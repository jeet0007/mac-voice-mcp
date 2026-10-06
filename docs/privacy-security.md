# Privacy and security

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

## Privacy and safety

- **Audio stays on your machine.** Recordings go to a temporary file that's deleted after each turn. The only network use is the one-time model download from Hugging Face, plus npm and Hugging Face once more if you install the Kokoro voice. Speaking never downloads anything.
- **The warm whisper server is local only.** It listens on `127.0.0.1` on a random port, and stops when idle or when this server exits.
- **Setup can only install known packages.** Its install list is fixed in the code (`sox`, `whisper-cpp`, and `kokoro-js@1.2.1` for the optional voice), so nothing Claude says can make it install anything else. It never uninstalls or modifies other software.
- **Licenses of the optional Kokoro voice.** The Kokoro model and kokoro-js are Apache-2.0. kokoro-js turns text into sounds with a WebAssembly build of espeak-ng (GPL-3.0), through the `phonemizer` package. None of this is part of mac-voice-mcp (MIT). It's installed on your Mac only if you ask for it.

## Security

- **Secrets:** every push and pull request is scanned for leaked secrets with [TruffleHog](https://github.com/trufflesecurity/trufflehog), and the whole history is scanned before the first push. GitHub secret scanning with push protection is also on.
- **Dependencies:** [Dependabot](https://docs.github.com/code-security/dependabot) opens weekly update pull requests. CI fails on high-severity advisories (`npm audit`), and dependency review blocks pull requests that add vulnerable packages.
- **Code:** [CodeQL](https://codeql.github.com) runs with the `security-extended` queries.
- **Releases:** releases publish through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), with no long-lived npm token and a signed provenance attestation for every version.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).
