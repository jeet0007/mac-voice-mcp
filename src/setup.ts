/**
 * voice_setup: check what's already on this machine, install only what's missing,
 * and only when asked (install=true, after the user agreed).
 *
 * Installs run in the background: if they take longer than a tool call should
 * wait, the report says "installing…" and the next voice_setup call picks up
 * the result. A slow `brew install` can never time the client out.
 */
import { statSync } from "node:fs";
import { describeRecorder, findRecorder, findTts } from "./audio.js";
import { CONFIG, IS_MAC, IS_WIN, log } from "./config.js";
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

  const rec = findRecorder();
  checks.push(
    rec
      ? { label: "Recorder", status: "ok", detail: describeRecorder(rec) }
      : { label: "Recorder", status: brewing ? "installing" : "missing", detail: "SoX is not installed", brew: IS_WIN ? undefined : "sox" },
  );

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

// --- The flow ------------------------------------------------------------------------------

/**
 * @param install    true only after the user agreed: brew-install missing formulae, download the model if absent.
 * @param onProgress optional heartbeat while waiting (used for MCP progress notifications).
 */
export async function runSetupFlow(install: boolean, onProgress?: (message: string) => void): Promise<SetupOutcome> {
  let checks = await checkRequirements();

  if (install) {
    const formulae = [...new Set(checks.filter((c) => c.status === "missing" && c.brew).map((c) => c.brew!))];
    const brew = findBrew();
    if (formulae.length && brew && !running(brewJob)) brewJob = startBrewInstall(brew, formulae);
    if (checks.some((c) => c.model && c.status === "missing") && !running(modelJob)) modelJob = startModelDownload();
  }

  // Wait (bounded) for anything in flight, with a heartbeat.
  const jobs = [brewJob, modelJob].filter(running);
  if (jobs.length) {
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (jobs.some((j) => !j.done) && Date.now() < deadline) {
      onProgress?.(jobs.filter((j) => !j.done).map((j) => `${j.label} (${elapsed(j)})`).join("; "));
      await Promise.race([Promise.all(jobs.map((j) => j.promise)), sleep(5000)]);
    }
    checks = await checkRequirements();
  }

  const installing = running(brewJob) || running(modelJob);
  const ready = checks.every((c) => c.status === "ok" || c.status === "optional");
  const icon: Record<CheckStatus, string> = { ok: "✔", missing: "✘", optional: "•", installing: "…" };
  const done = finishedMessages.splice(0);

  const lines = [
    `voice-mcp setup — ${ready ? "READY" : installing ? "INSTALLING" : "NOT READY"}`,
    "",
    ...checks.map((c) => `${icon[c.status]} ${c.label}: ${c.detail}${c.brew && c.status === "missing" ? ` → brew install ${c.brew}` : ""}`),
    IS_MAC ? "• Microphone: macOS asks for permission the first time speak_and_listen listens — click Allow." : "",
  ];
  if (done.length) lines.push("", "What was done:", ...done.map((d) => `- ${d}`));
  if (install && !done.length && !installing && ready) lines.push("", "Nothing to install — everything was already present.");

  const toInstall = [...new Set(checks.filter((c) => c.status === "missing" && c.brew).map((c) => c.brew!))];
  const needsModel = checks.some((c) => c.model && c.status === "missing");
  lines.push("");
  if (ready) {
    lines.push("Next: everything is in place — speak_and_listen is ready to use.");
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
