/**
 * `doctor`: an objective self-check of the whole voice pipeline on this Mac.
 *
 * Every check ends in PASS / WARN / FAIL against fixed limits, so "does it work?" is answered by
 * numbers rather than by ear. Results are also written as JSON, so reports from different Macs
 * and audio setups (headphones, Bluetooth, external mics) can be compared.
 *
 *   1. Setup          everything speak_and_listen needs is installed.
 *   2. Speech → text  the voice speaks a known sentence into a file and whisper transcribes it.
 *                     Checks the voice and the transcriber without involving the room.
 *   3. Speaker → mic  the same sentence is spoken live through the speakers (exactly as in a
 *                     conversation) while the mic records, then transcribed. Checks the real
 *                     hardware path (skipped with --no-loopback).
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chooseVoice, describeRecorder, findRecorder, recordForSeconds, speak, synthesizeToFile } from "./audio.js";
import { CONFIG, IS_MAC, PKG } from "./config.js";
import { ensureModel } from "./model.js";
import { run } from "./proc.js";
import { runSetupFlow } from "./setup.js";
import { describeStt, stopWhisperServer, transcribe } from "./stt.js";
import { wordErrorRate } from "./wer.js";

export const DOCTOR_SENTENCE = "The build passed and all tests are green. Should I open the pull request now?";

/** Word error rate limits: [PASS at or below, WARN at or below]; above that is FAIL. */
export const LIMITS = {
  /** Clean synthetic speech straight into whisper should be near perfect. */
  file: [0.1, 0.25],
  /** Through the air, room noise and a laptop mic make it harder. */
  loopback: [0.3, 0.5],
} as const;

export type Status = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface Check {
  name: string;
  status: Status;
  detail: string;
  metrics?: Record<string, number | string>;
}

export interface DoctorReport {
  version: string;
  date: string;
  machine: Record<string, string>;
  checks: Check[];
  ok: boolean;
  reportFile?: string;
}

/** Ends the run early without counting as an unexpected error. */
class StopChecks extends Error {}

const grade = (wer: number, [pass, warn]: readonly [number, number]): Status => (wer <= pass ? "PASS" : wer <= warn ? "WARN" : "FAIL");
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** WAV length in seconds (16 kHz mono 16-bit, 44-byte header). */
async function wavSeconds(file: string): Promise<number> {
  return Math.max(0, ((await stat(file)).size - 44) / 32000);
}

/** The default input and output device names (macOS), for the report. Best effort. */
async function audioDevices(): Promise<Record<string, string>> {
  if (!IS_MAC) return {};
  try {
    const r = await run("/usr/sbin/system_profiler", ["SPAudioDataType", "-json"], { timeoutMs: 10_000 });
    const items = (JSON.parse(r.stdout).SPAudioDataType?.[0]?._items ?? []) as Array<Record<string, string>>;
    const find = (key: string) => items.find((d) => d[key] === "spaudio_yes")?._name ?? "unknown";
    return { input: find("coreaudio_default_audio_input_device"), output: find("coreaudio_default_audio_output_device") };
  } catch {
    return {};
  }
}

export async function runDoctor(opts: { loopback?: boolean; reportDir?: string; log?: (line: string) => void } = {}): Promise<DoctorReport> {
  const say = opts.log ?? (() => {});
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    say(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
  };
  const tmp = await mkdtemp(path.join(os.tmpdir(), "voice-mcp-doctor-"));
  const report: DoctorReport = {
    version: PKG.version,
    date: new Date().toISOString(),
    machine: { platform: `${process.platform} ${os.release()}`, arch: process.arch, node: process.version, ...(await audioDevices()) },
    checks,
    ok: false,
  };

  try {
    // 1. Setup
    const setup = await runSetupFlow(false);
    add({ name: "Setup", status: setup.ready ? "PASS" : "FAIL", detail: setup.ready ? "everything is installed" : "something is missing — run `setup`" });
    if (!setup.ready) throw new StopChecks();
    const voice = await chooseVoice();
    const recorder = findRecorder();
    Object.assign(report.machine, {
      voice: voice.label,
      recorder: recorder ? describeRecorder(recorder) : "none",
      stt: describeStt(),
      model: CONFIG.modelPath ?? CONFIG.modelName,
    });
    const model = await ensureModel({ download: false });

    // 2. Speech → text, straight from a file
    const spoken = path.join(tmp, "spoken.wav");
    let t = Date.now();
    await synthesizeToFile(DOCTOR_SENTENCE, spoken);
    const synthMs = Date.now() - t;
    t = Date.now();
    const heardColdText = await transcribe(spoken, model);
    const coldMs = Date.now() - t;
    t = Date.now();
    const heard = await transcribe(spoken, model); // again, now that the model is loaded
    const warmMs = Date.now() - t;
    const fileScore = wordErrorRate(DOCTOR_SENTENCE, heard || heardColdText);
    const fileStatus = grade(fileScore.wer, LIMITS.file);
    add({
      name: "Speech → text",
      status: fileStatus,
      detail: `${pct(1 - fileScore.wer)} of words right (heard: "${heard}") — voice ${synthMs} ms, transcribe ${warmMs} ms (first ${coldMs} ms)`,
      metrics: { wer: fileScore.wer, synthMs, transcribeColdMs: coldMs, transcribeWarmMs: warmMs, audioSeconds: await wavSeconds(spoken) },
    });

    // 3. Speaker → mic, through the air
    if (opts.loopback === false || !IS_MAC) {
      add({ name: "Speaker → mic", status: "SKIP", detail: IS_MAC ? "skipped (--no-loopback)" : "macOS only" });
    } else {
      const recorded = path.join(tmp, "recorded.wav");
      const seconds = (await wavSeconds(spoken)) + 1.5;
      let player: Promise<unknown> | undefined;
      const rec = await recordForSeconds(seconds, recorded, () => {
        // The live voice at full quality, the way speak_and_listen speaks — not the 16 kHz test file.
        player ??= new Promise((r) => setTimeout(r, 300)).then(() => speak(DOCTOR_SENTENCE));
      });
      await player;
      if (rec.digitalSilence) {
        add({
          name: "Speaker → mic",
          status: "FAIL",
          detail: "the mic returned pure silence — allow microphone access for this app (System Settings → Privacy & Security → Microphone), or check the input device",
          metrics: { peakDb: rec.peakDb },
        });
      } else if (rec.peakDb < -50) {
        add({
          name: "Speaker → mic",
          status: "WARN",
          detail: `almost nothing reached the mic (peak ${Math.round(rec.peakDb)} dB). Expected with headphones — otherwise turn the volume up and run again`,
          metrics: { peakDb: rec.peakDb },
        });
      } else {
        t = Date.now();
        const heardAir = await transcribe(recorded, model);
        const airMs = Date.now() - t;
        const air = wordErrorRate(DOCTOR_SENTENCE, heardAir);
        add({
          name: "Speaker → mic",
          status: grade(air.wer, LIMITS.loopback),
          detail: `${pct(1 - air.wer)} of words right through the air (heard: "${heardAir}"), peak ${Math.round(rec.peakDb)} dB, transcribe ${airMs} ms`,
          metrics: { wer: air.wer, peakDb: rec.peakDb, transcribeMs: airMs },
        });
      }
    }
  } catch (err) {
    if (!(err instanceof StopChecks)) {
      add({ name: "Unexpected error", status: "FAIL", detail: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    stopWhisperServer();
    await rm(tmp, { recursive: true, force: true });
  }

  report.ok = checks.every((c) => c.status !== "FAIL");
  const dir = opts.reportDir ?? path.join(CONFIG.cacheDir, "doctor");
  try {
    await mkdir(dir, { recursive: true });
    report.reportFile = path.join(dir, `doctor-${report.date.replace(/[:.]/g, "-")}.json`);
    await writeFile(report.reportFile, JSON.stringify(report, null, 2) + "\n");
  } catch {
    /* the report file is a convenience */
  }
  return report;
}
