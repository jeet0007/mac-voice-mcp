/**
 * voice_setup: check what's already on this machine, install only what's missing,
 * and only when asked (install=true, after the user agreed).
 *
 * Installs run in the background: if they take longer than a tool call should
 * wait, the report says "installing…" and the next voice_setup call picks up
 * the result. A slow `brew install` can never time the client out.
 */
import { statSync } from "node:fs";
import { chooseVoice, describeRecorder, findRecorder, findTts, resetVoiceChoice, VOICE_UPGRADE_HINT } from "./audio.js";
import { CONFIG, IS_MAC, IS_WIN, log } from "./config.js";
import { installKokoro, isKokoroInstalled, isKokoroModelPresent, KOKORO_SIZES_MB, kokoroVoiceLabel } from "./kokoro.js";
import { ensureModel, isModelDownloading, locateModel, modelSource, MODEL_SIZES_MB } from "./model.js";
import { isExecutable, resetWhichCache, run, sleep, tail, which } from "./proc.js";
import { describeStt, findWhisperCli, findWhisperServer } from "./stt.js";

type CheckStatus = "ok" | "missing" | "optional" | "installing";

interface Check {
  label: string;
  status: CheckStatus;
  detail: string;
  /** Homebrew formula that fixes this item. */
  brew?: string;
  /** Fixed by the one-time model download. */
  model?: boolean;
  /** Fixed by installing the optional Kokoro voice (kokoro=true). */
  kokoro?: boolean;
}

export interface SetupOptions {
  /** true only after the user agreed: brew-install missing formulae, download the model if absent. */
  install?: boolean;
  /** true only after the user agreed: install the optional Kokoro voice (npm + ~330 MB model). */
  kokoro?: boolean;
  /** Optional heartbeat while waiting (used for MCP progress notifications). */
  onProgress?: (message: string) => void;
}

export interface SetupOutcome {
  ready: boolean;
  installing: boolean;
  report: string;
}

/** How long one voice_setup call waits for installs before reporting "still installing". */
const INSTALL_WAIT_MS = 40_000;

export function findBrew(): string | null {
  if (process.env.VOICE_MCP_EXTRA_PATH !== undefined) return which("brew"); // isolated (tests): PATH only
  return which("brew") ?? ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(isExecutable) ?? null;
}

// --- Background jobs (survive across tool calls) --------------------------------------------

interface Job {
  label: string;
  startedAt: number;
  done: boolean;
  result?: string;
  promise: Promise<void>;
}

let brewJob: Job | null = null;
let modelJob: Job | null = null;
let kokoroJob: Job | null = null;
/** The Kokoro install's latest progress line. */
let kokoroProgress = "";
/** Results of finished jobs not yet shown to the user. */
const finishedMessages: string[] = [];

function startJob(label: string, work: () => Promise<string>): Job {
  const job: Job = { label, startedAt: Date.now(), done: false, promise: Promise.resolve() };
  job.promise = work()
    .then((msg) => {
      job.result = msg;
    })
    .catch((e: unknown) => {
      job.result = `${label} failed: ${e instanceof Error ? e.message : e}`;
    })
    .finally(() => {
      job.done = true;
      resetWhichCache();
      finishedMessages.push(job.result!);
      log(job.result);
    });
  return job;
}

function startBrewInstall(brew: string, formulae: string[]): Job {
  return startJob(`brew install ${formulae.join(" ")}`, async () => {
    log(`Running: brew install ${formulae.join(" ")}`);
    const r = await run(brew, ["install", ...formulae], {
      timeoutMs: 30 * 60_000,
      env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", NONINTERACTIVE: "1" },
    });
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${tail(r.stderr, 4)}`);
    return `Installed with Homebrew: ${formulae.join(", ")}.`;
  });
}

function startModelDownload(): Job {
  return startJob(`Downloading the ${CONFIG.modelName} model`, async () => {
    await ensureModel({ download: true });
    return `Downloaded the ${CONFIG.modelName} speech model.`;
  });
}

function startKokoroInstall(): Job {
  kokoroProgress = "starting";
  return startJob("Installing the Kokoro voice", () => installKokoro((m) => (kokoroProgress = m)));
}

const running = (j: Job | null): j is Job => !!j && !j.done;
const elapsed = (j: Job) => `${Math.round((Date.now() - j.startedAt) / 1000)}s`;

// --- Checks -------------------------------------------------------------------------------

async function checkRequirements(): Promise<Check[]> {
  const checks: Check[] = [];
  const brewing = running(brewJob);

  const tts = findTts();
  checks.push(
    tts
      ? { label: "Text-to-speech", status: "ok", detail: IS_MAC ? "macOS `say` (built in)" : tts }
      : { label: "Text-to-speech", status: "missing", detail: "no engine found — install espeak-ng (`sudo apt install espeak-ng`)" },
  );
  const kokoro = kokoroCheck();
  if (tts && IS_MAC) {
    resetVoiceChoice(); // pick up a voice downloaded since the last check
    const choice = await chooseVoice();
    checks.push(
      kokoro?.status === "ok"
        ? { label: "Voice", status: "ok", detail: `${choice.label} (used if the Kokoro voice ever fails)` }
        : choice.canUpgrade
          ? { label: "Voice", status: "optional", detail: `${choice.label} — ${VOICE_UPGRADE_HINT}` }
          : { label: "Voice", status: "ok", detail: choice.label },
    );
  }
  if (kokoro) checks.push(kokoro);

  const rec = findRecorder();
  if (!rec) {
    checks.push({ label: "Recorder", status: brewing ? "installing" : "missing", detail: "SoX is not installed", brew: IS_WIN ? undefined : "sox" });
  } else if (rec.kind === "ffmpeg" && CONFIG.recorder === "auto") {
    // Works, but it's the fragile path: recommend SoX, which is what the turn-taking is tuned on.
    checks.push({
      label: "Recorder",
      status: brewing ? "installing" : "optional",
      detail: `${describeRecorder(rec)}, as a fallback. SoX is recommended: it's more reliable with Bluetooth headsets and other audio devices`,
      brew: "sox",
    });
  } else {
    checks.push({ label: "Recorder", status: "ok", detail: describeRecorder(rec) });
  }

  const cli = findWhisperCli();
  const server = findWhisperServer();
  if (cli || server) {
    checks.push({ label: "Speech-to-text", status: "ok", detail: `whisper.cpp — ${describeStt()}` });
  } else {
    checks.push({
      label: "Speech-to-text",
      status: brewing ? "installing" : "missing",
      detail: "whisper.cpp is not installed",
      brew: IS_WIN ? undefined : "whisper-cpp",
    });
  }

  try {
    const model = running(modelJob) || isModelDownloading() ? null : await locateModel();
    if (model) {
      const mb = (statSync(model).size / 1e6).toFixed(0);
      checks.push({ label: "Speech model", status: "ok", detail: `${CONFIG.modelName} (${mb} MB) — ${modelSource}` });
    } else {
      const size = MODEL_SIZES_MB[CONFIG.modelName];
      checks.push({
        label: "Speech model",
        status: running(modelJob) ? "installing" : "missing",
        detail: running(modelJob)
          ? `downloading ${CONFIG.modelName} (${elapsed(modelJob!)} so far)`
          : `${CONFIG.modelName} is not on this computer — one-time download${size ? ` of ~${size} MB` : ""} to ${CONFIG.modelsDir}`,
        model: true,
      });
    }
  } catch (e) {
    checks.push({ label: "Speech model", status: "missing", detail: e instanceof Error ? e.message : String(e) });
  }

  if (checks.some((c) => c.brew && c.status === "missing")) {
    const brew = findBrew();
    checks.push(
      brew
        ? { label: "Homebrew", status: "ok", detail: `found (${brew})` }
        : {
            label: "Homebrew",
            status: "missing",
            detail: "not installed, so packages can't be installed automatically — install it in Terminal from https://brew.sh (it needs your password), then run setup again",
          },
    );
  }
  return checks;
}

/** The optional Kokoro voice: shown once it's installed or asked for (VOICE_MCP_TTS=kokoro), or while installing. */
function kokoroCheck(): Check | null {
  const label = "Kokoro voice";
  if (running(kokoroJob)) return { label, status: "installing", detail: `${kokoroProgress} (${elapsed(kokoroJob!)} so far)` };
  if (CONFIG.tts === "say") return null;
  const installed = isKokoroInstalled();
  const size = `~${KOKORO_SIZES_MB[CONFIG.kokoroDtype]} MB`;
  if (installed && isKokoroModelPresent()) {
    return { label, status: "ok", detail: `${kokoroVoiceLabel()} — the natural on-device voice, used for speaking (VOICE_MCP_TTS=say turns it off)` };
  }
  if (installed) {
    return { label, status: "optional", detail: `installed, but its model isn't downloaded yet (${size}) — until then the built-in voice speaks`, kokoro: true };
  }
  if (CONFIG.tts === "kokoro") {
    return {
      label,
      status: "optional",
      detail: `VOICE_MCP_TTS=kokoro, but it isn't installed — a one-time install (kokoro-js with npm, and a ${size} model; about 1 GB on disk) into ${CONFIG.kokoroDir}. Until then the built-in voice speaks`,
      kokoro: true,
    };
  }
  return null;
}

// --- The flow ------------------------------------------------------------------------------

export async function runSetupFlow(opts: SetupOptions = {}): Promise<SetupOutcome> {
  const { install = false, onProgress } = opts;
  resetWhichCache(); // see anything installed since the last check (e.g. `brew install sox` in a terminal)
  let checks = await checkRequirements();

  if (install) {
    // Missing pieces, plus recommended ones (SoX when only ffmpeg is there): the user agreed to install.
    const formulae = [...new Set(checks.filter((c) => (c.status === "missing" || c.status === "optional") && c.brew).map((c) => c.brew!))];
    const brew = findBrew();
    if (formulae.length && brew && !running(brewJob)) brewJob = startBrewInstall(brew, formulae);
    if (checks.some((c) => c.model && c.status === "missing") && !running(modelJob)) modelJob = startModelDownload();
  }
  if (opts.kokoro && !running(kokoroJob) && !(isKokoroInstalled() && isKokoroModelPresent())) kokoroJob = startKokoroInstall();

  // Wait (bounded) for anything in flight, with a heartbeat.
  const jobs = [brewJob, modelJob, kokoroJob].filter(running);
  if (jobs.length) {
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (jobs.some((j) => !j.done) && Date.now() < deadline) {
      onProgress?.(
        jobs
          .filter((j) => !j.done)
          .map((j) => `${j.label} (${j === kokoroJob ? `${kokoroProgress}, ` : ""}${elapsed(j)})`)
          .join("; "),
      );
      await Promise.race([Promise.all(jobs.map((j) => j.promise)), sleep(5000)]);
    }
    checks = await checkRequirements();
  }

  const installing = running(brewJob) || running(modelJob) || running(kokoroJob);
  const ready = checks.every((c) => c.status === "ok" || c.status === "optional");
  const icon: Record<CheckStatus, string> = { ok: "✔", missing: "✘", optional: "•", installing: "…" };
  const done = finishedMessages.splice(0);

  const lines = [
    `voice-mcp setup — ${ready ? "READY" : installing ? "INSTALLING" : "NOT READY"}`,
    "",
    ...checks.map((c) => `${icon[c.status]} ${c.label}: ${c.detail}${c.brew && c.status !== "ok" && c.status !== "installing" ? ` → brew install ${c.brew}` : ""}`),
    IS_MAC ? "• Microphone: macOS asks for permission the first time speak_and_listen listens — click Allow." : "",
  ];
  if (done.length) lines.push("", "What was done:", ...done.map((d) => `- ${d}`));
  if ((install || opts.kokoro) && !done.length && !installing && ready) lines.push("", "Nothing to install — everything was already present.");

  const toInstall = [...new Set(checks.filter((c) => c.status === "missing" && c.brew).map((c) => c.brew!))];
  const needsModel = checks.some((c) => c.model && c.status === "missing");
  lines.push("");
  if (ready) {
    lines.push("Next: everything is in place — speak_and_listen is ready to use.");
    const recommended = [...new Set(checks.filter((c) => c.status === "optional" && c.brew).map((c) => c.brew!))];
    if (recommended.length && !install && findBrew()) {
      lines.push(
        `Recommended: ask the user whether to brew install ${recommended.join(" ")} (see • above). ` +
          "Only if they agree, call voice_setup with install=true.",
      );
    }
    if (checks.some((c) => c.kokoro && c.status === "optional") && !opts.kokoro) {
      lines.push(
        `Optional: ask the user whether to install the Kokoro voice (a one-time install, about 1 GB on disk). ` +
          "Only if they agree, call voice_setup with kokoro=true.",
      );
    }
    if (checks.some((c) => c.label === "Voice" && c.status === "optional")) {
      lines.push(
        "Mention the optional voice tip (•) to the user once — it makes the voice sound far more natural. " +
          "If they'd rather not download a macOS voice, the Kokoro voice (voice_setup with kokoro=true, about 1 GB on disk) is the other option. Nothing else to do.",
      );
    }
  } else if (installing) {
    lines.push("Next: installation is still running in the background. Tell the user, wait about a minute, then call voice_setup again (install=false) to check.");
  } else if (!install && (toInstall.length || needsModel) && (findBrew() || !toInstall.length)) {
    const steps = [toInstall.length ? `brew install ${toInstall.join(" ")}` : "", needsModel ? `download the ${CONFIG.modelName} model` : ""]
      .filter(Boolean)
      .join(" and ");
    lines.push(`Next: ask the user whether to ${steps}. Only if they agree, call voice_setup with install=true.`);
  } else {
    lines.push("Next: the items marked ✘ need the user's attention (see details above); then call voice_setup again.");
  }

  return {
    ready,
    installing,
    report: lines.filter((l, i, a) => !(l === "" && (i === 0 || a[i - 1] === ""))).join("\n").trim(),
  };
}
