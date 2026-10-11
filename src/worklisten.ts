/**
 * Talking to Claude while it works (Claude Code plugin).
 *
 * After a voice turn in which the user answered, the mic stays open while Claude works. Anything
 * said that starts with Claude's name ("Claude, use the other branch") is transcribed on this Mac
 * and left in a small inbox; the plugin's hook (hooks/voice-mode-lib.mjs) hands it to Claude after
 * its next tool call, or when it tries to stop. Everything else heard is transcribed, checked for
 * the name, and dropped: nothing is kept.
 *
 * It only runs while the plugin's hook says this session is in voice mode (the hook writes
 * listening.state right after each voice turn and removes it when the user types), so apps
 * without the hook (Claude Desktop, Cursor) never get an open mic. It stops at the next voice
 * turn, when voice mode ends, when another session takes over, and after
 * VOICE_MCP_WORK_LISTEN_MINUTES (default 10) without a voice turn.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chime, findRecorder, listenForTurn } from "./audio.js";
import { CONFIG, debug, envNum } from "./config.js";
import { lockFile } from "./lock.js";
import { ensureModel } from "./model.js";
import { CancelledError, sleep } from "./proc.js";
import { transcribe } from "./stt.js";

/** Shared with the hook: both live in the voice-mode state folder. */
export const voiceModeDir = () => path.join(CONFIG.cacheDir, "voice-mode");
export const listeningFile = () => path.join(voiceModeDir(), "listening.state");
export const inboxDir = () => path.join(voiceModeDir(), "inbox");

/** How long after our voice turn the hook has to confirm voice mode before we give up (no hook → no listening). */
const CONFIRM_MS = Math.max(200, envNum("VOICE_MCP_WORK_LISTEN_CONFIRM_MS", 10_000));
/** How often, while listening, we check whether to stop (the user typed, voice mode ended, …). */
const WATCH_MS = 250;
/** Inbox entries older than this are stale and never delivered. */
export const INBOX_MAX_AGE_MS = 15 * 60_000;

/**
 * "Claude, use the other branch" → "use the other branch". Only speech that starts with Claude's
 * name counts (optionally after "hey", "okay"…), so talk in the room, a call or a video is ignored.
 * Returns null when it isn't addressed to Claude, and "" when it's only the name ("Claude?").
 */
export function parseInterjection(text: string): string | null {
  const t = text.trim();
  // whisper's usual spellings of the name; "cloud" only with a pause after it ("Cloud, …"), since
  // "Cloud deployment failed" is ordinary talk.
  const m = /^(?:(?:hey|hi|okay|ok|so|um|uh|oh)[,.]?\s+)?(?:(?:claude|claud|clyde|klaud|clod)\b[,.!?:;]*|cloud[,.!?:;]+)\s*/i.exec(t);
  if (!m) return null;
  return t.slice(m[0].length).trim();
}

export interface InboxEntry {
  text: string;
  at: number;
}

/** Leave something the user said for the hook (or the next voice turn) to hand to Claude. */
export function addToInbox(text: string, now = Date.now()): void {
  mkdirSync(inboxDir(), { recursive: true });
  const file = path.join(inboxDir(), `${now}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify({ text, at: now } satisfies InboxEntry));
}

/** Take everything waiting in the inbox (oldest first), removing it. Stale entries are dropped. */
export function takeInbox(now = Date.now()): InboxEntry[] {
  let names: string[];
  try {
    names = readdirSync(inboxDir()).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: InboxEntry[] = [];
  for (const name of names) {
    const file = path.join(inboxDir(), name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as InboxEntry;
      rmSync(file, { force: true });
      if (typeof entry.text === "string" && now - entry.at < INBOX_MAX_AGE_MS) out.push(entry);
    } catch {
      rmSync(file, { force: true });
    }
  }
  return out;
}

/** What the next voice turn tells Claude about interjections the hook hasn't delivered yet. */
export function interjectionNote(entries: InboxEntry[]): string | null {
  if (!entries.length) return null;
  const said = entries.map((e) => (e.text ? `"${e.text}"` : "(only your name: they want to talk)")).join(", then ");
  return `voice-mcp note: while you were working, the user said by voice: ${said}. Take it into account in this reply.`;
}

function readListening(): { at: number } | null {
  try {
    const s = JSON.parse(readFileSync(listeningFile(), "utf8")) as { at?: unknown };
    return typeof s.at === "number" ? { at: s.at } : null;
  } catch {
    return null;
  }
}

/** Another process is in a voice turn (it holds the mic lock): don't compete with it. */
function micBusyElsewhere(): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockFile(), "utf8")) as { pid?: number };
    return typeof owner.pid === "number" && owner.pid !== process.pid;
  } catch {
    return false;
  }
}

class WorkListener {
  private ctl: AbortController | null = null;
  private loop: Promise<void> | null = null;

  get running(): boolean {
    return this.ctl !== null;
  }

  /** Start listening after the voice turn that just ended at `turnEnd`. */
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

  /** Stop and wait until the mic is free again. */
  async stop(): Promise<void> {
    this.ctl?.abort();
    await this.loop;
    this.ctl = null;
    this.loop = null;
  }

  private async run(turnEnd: number, signal: AbortSignal): Promise<void> {
    const idleMs = Math.max(1, envNum("VOICE_MCP_WORK_LISTEN_MINUTES", 10)) * 60_000;
    // Voice mode is confirmed when the hook marks this session right after our turn. Later marks
    // come from another session's turn: it takes over, and we stop.
    const ours = (s: { at: number } | null) => !!s && s.at >= turnEnd - 2_000 && s.at <= turnEnd + CONFIRM_MS;
    const confirmBy = Date.now() + CONFIRM_MS;
    while (!ours(readListening())) {
      if (Date.now() > confirmBy) return; // no plugin hook here, or voice mode ended right away
      await sleep(200);
      if (signal.aborted) return;
    }

    const model = await ensureModel({ download: false });
    const tmp = await mkdtemp(path.join(os.tmpdir(), "voice-mcp-work-"));
    try {
      while (!signal.aborted) {
        if (!ours(readListening())) return; // the user typed, voice mode ended, or another session took over
        if (Date.now() - turnEnd > idleMs) return;
        if (micBusyElsewhere()) {
          await sleep(1000);
          continue;
        }
        const wav = path.join(tmp, "heard.wav");
        // Check a few times a second, so the mic closes right away when the user types, voice mode
        // ends or another session starts a turn, not only after the next 15-second wait.
        const listening = new AbortController();
        const onStop = () => listening.abort();
        signal.addEventListener("abort", onStop, { once: true });
        const watch = setInterval(() => {
          if (!ours(readListening()) || micBusyElsewhere() || Date.now() - turnEnd > idleMs) listening.abort();
        }, WATCH_MS);
        let heard: Awaited<ReturnType<typeof listenForTurn>>;
        try {
          heard = await listenForTurn(30, wav, listening.signal);
        } catch (e) {
          if (e instanceof CancelledError) continue; // the checks at the top of the loop decide what's next
          throw e;
        } finally {
          clearInterval(watch);
          signal.removeEventListener("abort", onStop);
        }
        if (signal.aborted) return;
        if (heard.reason === "no-speech" || heard.digitalSilence) continue;
        const text = await transcribe(wav, model, signal);
        const said = parseInterjection(text);
        debug(`work listener heard: ${JSON.stringify(text)} → ${said === null ? "not for Claude" : JSON.stringify(said)}`);
        if (said === null || signal.aborted) continue;
        addToInbox(said);
        void chime("stop"); // a soft "got it"
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

export const workListener = new WorkListener();
