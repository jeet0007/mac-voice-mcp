/** Where speech plays (headphones or speakers) and pausing it, for a call's barge-in. */
import type { ChildProcess } from "node:child_process";
import { CONFIG, IS_MAC, IS_WIN, log } from "./config.js";
import { run, tail, which } from "./proc.js";

/** Processes playing speech, until they exit. */
const speakers = new Set<ChildProcess>();
let speechPaused = false;

/**
 * Pause (true) or resume (false) all speech, for the user talking over it. SIGSTOP silences `say`
 * or SoX `play` within 200 ms and SIGCONT resumes mid-sentence. A stopped process can't act on
 * SIGTERM, so whoever stops paused speech must resume it right after.
 */
export function pauseSpeech(paused: boolean): void {
  speechPaused = paused;
  if (IS_WIN) return; // no SIGSTOP: Windows would kill it (detectDuplex keeps calls there half duplex)
  for (const child of speakers) child.kill(paused ? "SIGSTOP" : "SIGCONT");
}

/** Make pauseSpeech() reach `child` until it exits; one started while speech is paused is paused at once. */
export function trackSpeaker(child: ChildProcess): void {
  speakers.add(child);
  child.once("close", () => speakers.delete(child));
  if (speechPaused && !IS_WIN) child.kill("SIGSTOP");
}

/**
 * Does `system_profiler SPAudioDataType -json` say the default output is headphones? The built-in
 * jack's headphones, or Bluetooth unless its name says speaker (AirPods yes, a Bluetooth speaker no).
 */
export function headphonesFromProfile(json: unknown): boolean {
  type Item = { _name?: string; coreaudio_default_audio_output_device?: string; coreaudio_device_transport?: string; coreaudio_output_source?: string };
  const groups = (json as { SPAudioDataType?: { _items?: Item[] }[] } | null)?.SPAudioDataType ?? [];
  const out = groups.flatMap((g) => g._items ?? []).find((i) => i.coreaudio_default_audio_output_device === "spaudio_yes");
  if (!out) return false;
  if (/headphone/i.test(out.coreaudio_output_source ?? "")) return true;
  return out.coreaudio_device_transport === "coreaudio_device_type_bluetooth" && !/speaker/i.test(out._name ?? "");
}

/**
 * Can a call keep the mic open while Claude speaks? VOICE_MCP_CALL_DUPLEX, or for auto: full on
 * headphones (no echo to hear back), half otherwise. Never full where speech can't be paused (Windows).
 */
export async function detectDuplex(): Promise<"full" | "half"> {
  if (IS_WIN) return "half";
  if (CONFIG.callDuplex !== "auto") return CONFIG.callDuplex;
  if (!IS_MAC) return "half";
  try {
    const bin = which("system_profiler") ?? "/usr/sbin/system_profiler";
    const r = await run(bin, ["SPAudioDataType", "-json"], { timeoutMs: 5000 });
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${tail(r.stderr) || "no output"}`);
    return headphonesFromProfile(JSON.parse(r.stdout)) ? "full" : "half";
  } catch (e) {
    log(`Couldn't tell whether headphones are on, so the call mutes the mic while Claude speaks: ${e instanceof Error ? e.message : String(e)}`);
    return "half";
  }
}
