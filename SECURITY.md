# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: go to the repository's **Security** tab, then **Report a vulnerability**. I'll reply as soon as I can. This is a personal, vibe-coded project, so please be patient, but reports are taken seriously.

## Supported versions

Only the latest release gets fixes.

## What this server can do on your machine

It helps to know the attack surface:

- **Microphone and speakers.** It speaks and records only while the `speak_and_listen` tool runs. Audio goes to a temporary file that's deleted after each turn, and it never leaves the machine.
- **Local processes.** It runs `say`, SoX or ffmpeg, and whisper.cpp. Arguments are passed as arrays, never through a shell, and spoken text goes in on stdin, so nothing the model writes can inject a command-line flag.
- **A local HTTP server.** The warm `whisper-server` listens on `127.0.0.1` on a random port. It runs under a watchdog that stops it when this server exits, and it shuts down after 15 idle minutes.
- **Installs, only when you agree.** `voice_setup` with `install=true` runs `brew install` for a fixed list of packages (`sox`, `whisper-cpp`), so nothing the model says can change what gets installed. It never uninstalls anything.
- **Network.** The only network access is the one-time model download from Hugging Face (`VOICE_MCP_MODEL_BASE_URL` changes where from). The file is checked to be a real whisper.cpp model before it's used.

## How the project protects itself

- **Secret scanning:** TruffleHog on every push and pull request, and a full-history scan before the first push. GitHub's secret scanning with push protection is also on.
- **Dependencies:** Dependabot keeps them current, CI fails on high-severity advisories in runtime dependencies (`npm audit`), and dependency review blocks pull requests that add vulnerable packages.
- **Code:** CodeQL scans the source with the `security-extended` queries.
- **Releases:** releases publish through npm trusted publishing (OIDC), so no long-lived npm token exists. Every release carries a provenance attestation linking it to the exact commit and workflow that built it. Check it with `npm audit signatures`.
