// Keeps the mic open while Claude works and leaves "Claude, ..." in the inbox. See docs/specs/voice-mode.md.
import { findRecorder, MicBusyError, openAudio, type AudioSession } from "./audio/device.js";
import { CONFIG, debug, envNum } from "./config.js";
import { chime } from "./cues.js";
import { listenForTurn, type Turn } from "./listen/utterances.js";
import { ensureModel } from "./model.js";
import { CancelledError, sleep } from "./proc.js";
import { addToInbox, readListening, setOwnSession, stopRequestedSince, type InboxEntry } from "./state/voice-mode.js";
import { transcribeBuffer } from "./stt.js";

const CONFIRM_MS = Math.max(200, envNum("VOICE_MCP_WORK_LISTEN_CONFIRM_MS", 10_000));
const WATCH_MS = 250;
// "Claude, use the other branch" → "use the other branch"; null when not addressed to Claude, "" for only the name.
export function parseInterjection(text: string): string | null {
  const t = text.trim();
  // "cloud" only with punctuation after it: "Cloud deployment failed" is ordinary talk
  const m = /^(?:(?:hey|hi|okay|ok|so|um|uh|oh)[,.]?\s+)?(?:(?:claude|claud|clyde|klaud|clod)\b[,.!?:;]*|cloud[,.!?:;]+)\s*/i.exec(t);
  if (!m) return null;
  return t.slice(m[0].length).trim();
}

export function interjectionNote(entries: InboxEntry[]): string | null {
  if (!entries.length) return null;
  const said = entries.map((e) => (e.text ? `"${e.text}"` : "(only your name: they want to talk)")).join(", then ");
  return `voice-mcp note: while you were working, the user said by voice: ${said}. Take it into account in this reply.`;
}

class WorkListener {
  private ctl: AbortController | null = null;
  private loop: Promise<void> | null = null;

  get running(): boolean {
    return this.ctl !== null;
  }

  start(turnEnd = Date.now()): void {
    if (!CONFIG.listenWhileWorking || this.ctl || !findRecorder()) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    debug("work listener: starting");
    this.loop = this.run(turnEnd, ctl.signal)
      .catch((e: unknown) => {
        if (!(e instanceof CancelledError)) debug("work listener stopped:", e instanceof Error ? e.message : e);
      })
      .finally(() => {
        if (this.ctl === ctl) this.ctl = null;
        debug("work listener: stopped");
      });
  }

  async stop(): Promise<void> {
    this.ctl?.abort();
    await this.loop;
    this.ctl = null;
    this.loop = null;
  }

  private async run(turnEnd: number, signal: AbortSignal): Promise<void> {
    const idleMs = Math.max(1, envNum("VOICE_MCP_WORK_LISTEN_MINUTES", 10)) * 60_000;
    // a mark after the window is another session's turn taking over
    const ours = (s: { at: number } | null) => !!s && s.at >= turnEnd - 2_000 && s.at <= turnEnd + CONFIRM_MS;
    const confirmBy = Date.now() + CONFIRM_MS;
    while (!ours(readListening())) {
      if (Date.now() > confirmBy) return;
      await sleep(200);
      if (signal.aborted) return;
    }

    setOwnSession(readListening()?.session);
    const model = await ensureModel({ download: false });
    {
      while (!signal.aborted) {
        if (!ours(readListening()) || stopRequestedSince(turnEnd)) return;
        if (Date.now() - turnEnd > idleMs) return;
        let session: AudioSession;
        try {
          session = await openAudio({ purpose: "worklisten" });
        } catch (e) {
          if (!(e instanceof MicBusyError)) throw e;
          await sleep(1000);
          continue;
        }
        const stopped = new AbortController();
        const watch = setInterval(() => {
          if (!ours(readListening()) || stopRequestedSince(turnEnd) || Date.now() - turnEnd > idleMs) stopped.abort();
        }, WATCH_MS);
        let heard: Turn;
        try {
          heard = await listenForTurn(session, 30, { signal: AbortSignal.any([signal, session.signal, stopped.signal]) });
        } catch (e) {
          if (e instanceof CancelledError) continue;
          throw e;
        } finally {
          clearInterval(watch);
          await session.close(); // one recorder at a time
        }
        if (signal.aborted) return;
        if (heard.reason === "no-speech" || heard.digitalSilence) continue;
        const text = await transcribeBuffer(heard.wav, model, signal);
        const said = parseInterjection(text);
        debug(`work listener heard: ${JSON.stringify(text)} → ${said === null ? "not for Claude" : JSON.stringify(said)}`);
        if (said === null || signal.aborted) continue;
        addToInbox(said);
        void chime("stop");
      }
    }
  }
}

export const workListener = new WorkListener();
