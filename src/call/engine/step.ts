/** Every rule of a call, as one pure function: no audio, no clock, no I/O (docs/specs/call-audio-redesign.md). */
import {
  GIVE_UP_MS,
  THINKING_EVERY_MS,
  THINKING_MAX_MS,
  type ClaudeTurn,
  type Effect,
  type EndReason,
  type Event,
  type Heard,
  type Ms,
  type OnCall,
  type Policy,
  type SayId,
  type State,
  type UtteranceId,
} from "./types.js";

type Step = readonly [State, readonly Effect[]];

const IDLE: ClaudeTurn = { kind: "idle" };

export const initial = (policy: Policy, at: Ms): OnCall => ({ phase: "on", policy, lastActivityAt: at, user: "quiet", claude: IDLE, missed: 0, undelivered: false });

/**
 * What the call does about `event`. Total: an event that means nothing in this state (a late
 * playback.ended, a stray tick, anything after the call ended) returns the state and no effects.
 */
export function step(state: State, event: Event): Step {
  if (state.phase === "off") return [state, []];
  switch (event.type) {
    case "speech.onset":
      return onset(state, event.at);
    case "speech.dropped":
      return quiet(state, event.at);
    case "utterance.ended":
      return quiet(awaitTranscript(state, event.utterance), event.at);
    case "transcribed":
      return transcribed(state, event.utterance, event.heard, event.at);
    case "transcribe.failed":
      return settle({ ...forget(state, event.utterance, false), missed: state.missed + 1 }, event.at);
    case "say.requested":
      return say(state, event.say, event.at);
    case "playback.ended":
      return state.claude.kind === "speaking" && state.claude.say === event.say
        ? next({ ...state, lastActivityAt: event.at }, state.claude.queue, state.claude.owesReply, event.at)
        : [state, []];
    case "inbox.drained":
      return drained(state, event.at);
    case "end.requested":
      return end(state, event.reason);
    case "tick":
      return tick(state, event.at);
  }
}

/** When the shell must send the next `tick`: the earliest deadline in the state. null once the call is over. */
export function nextWake(state: State): Ms | null {
  if (state.phase === "off") return null;
  const { claude, user, policy, lastActivityAt } = state;
  const wakes = [lastActivityAt + policy.idleMs];
  // No ticks while the user talks, but thinking still runs out.
  if (claude.kind === "thinking") wakes.push(user === "talking" ? claude.since + THINKING_MAX_MS : claude.lastTickAt + THINKING_EVERY_MS);
  if (claude.kind === "speaking" && claude.interruption && user === "quiet" && !claude.interruption.pending.length) wakes.push(claude.interruption.at + GIVE_UP_MS);
  return Math.min(...wakes);
}

/** Claude is free to speak: play the next say, hold it while the user talks on speakers, or go back to thinking. */
function next(s: OnCall, queue: readonly SayId[], owesReply: boolean, at: Ms): Step {
  const [say, ...rest] = queue;
  if (say === undefined) return [{ ...s, claude: owesReply ? thinking(s, at) : IDLE }, []];
  // On speakers the mic goes deaf while Claude speaks, which would cut the user's sentence short.
  if (s.policy.interrupt === "none" && s.user === "talking") return [{ ...s, claude: { kind: "held", queue: [say, ...rest], owesReply } }, []];
  return [{ ...s, claude: { kind: "speaking", say, startedAt: at, pausedMs: 0, interruption: null, queue: rest, owesReply } }, [{ type: "speech.start", say }]];
}

const thinking = (s: OnCall, at: Ms): ClaudeTurn => (s.policy.thinkingTick ? { kind: "thinking", since: at, lastTickAt: at } : IDLE);

function say(s: OnCall, id: SayId, at: Ms): Step {
  // Claude is talking: words taken before this, or with this say's result, need no ticks.
  const answered = { ...s, undelivered: false };
  const c = s.claude;
  if (c.kind === "speaking") return [{ ...answered, claude: { ...c, queue: [...c.queue, id], owesReply: false } }, []];
  return next(answered, c.kind === "held" ? [...c.queue, id] : [id], false, at);
}

function onset(s: OnCall, at: Ms): Step {
  if (s.user === "talking") return [s, []];
  const talking = { ...s, user: "talking" as const };
  const c = s.claude;
  if (s.policy.interrupt !== "pause" || c.kind !== "speaking" || c.interruption) return [talking, []];
  return [{ ...talking, claude: { ...c, interruption: { at, pending: [], filler: false } } }, [{ type: "speech.pause", say: c.say }]];
}

/** The user stopped talking, however it ended: a held say starts, a paused reply may resume. */
function quiet(s: OnCall, at: Ms): Step {
  const q = { ...s, user: "quiet" as const };
  return q.claude.kind === "held" ? next(q, q.claude.queue, q.claude.owesReply, at) : settle(q, at);
}

/** An utterance said over a reply decides, once transcribed, whether the reply stops. */
function awaitTranscript(s: OnCall, utterance: UtteranceId): OnCall {
  const c = s.claude;
  if (c.kind !== "speaking" || !c.interruption) return s;
  return { ...s, claude: { ...c, interruption: { ...c.interruption, pending: [...c.interruption.pending, utterance] } } };
}

/** The reply `utterance` was said over, while that is still undecided. */
function interrupted(s: OnCall, utterance: UtteranceId) {
  const c = s.claude;
  if (c.kind !== "speaking" || !c.interruption?.pending.includes(utterance)) return null;
  return { ...c, interruption: c.interruption };
}

/** `utterance` is transcribed, or failed: its interruption, if any, no longer waits for it. */
function forget(s: OnCall, utterance: UtteranceId, filler: boolean): OnCall {
  const c = interrupted(s, utterance);
  if (!c) return s;
  const { at, pending } = c.interruption;
  return { ...s, claude: { ...c, interruption: { at, pending: pending.filter((u) => u !== utterance), filler: filler || c.interruption.filler } } };
}

function transcribed(s: OnCall, utterance: UtteranceId, heard: Heard, at: Ms): Step {
  if (heard === "hang-up") return end(s, "hang-up");
  const over = interrupted(s, utterance);
  if (!over) return heard === "empty" ? [s, []] : deliver(s, utterance, [], null, at);
  // A filler ("mm-hm") or a cough over Claude: nothing for Claude, and its reply resumes.
  if (heard !== "words") return settle(forget(s, utterance, true), at);
  const playedMs = over.interruption.at - over.startedAt - over.pausedMs;
  const stopped: Effect[] = [{ type: "speech.stop", say: over.say }, ...drop(over.queue)];
  return deliver({ ...s, claude: { ...over, interruption: null, queue: [] } }, utterance, stopped, { say: over.say, playedMs }, at);
}

const drop = (queue: readonly SayId[]): Effect[] => queue.map((say) => ({ type: "speech.drop", say }));

function deliver(s: OnCall, utterance: UtteranceId, before: readonly Effect[], cut: { say: SayId; playedMs: number } | null, at: Ms): Step {
  return [
    { ...s, missed: 0, undelivered: true, lastActivityAt: at },
    [...before, { type: "deliver", utterance, interrupted: cut, missed: s.missed }],
  ];
}

/** Resume a talked-over reply once the user has stopped and said nothing real: a filler, or nothing within GIVE_UP_MS. */
function settle(s: OnCall, at: Ms): Step {
  const c = s.claude;
  if (c.kind !== "speaking" || !c.interruption || s.user === "talking" || c.interruption.pending.length) return [s, []];
  const { at: since, filler } = c.interruption;
  if (!filler && at - since < GIVE_UP_MS) return [s, []];
  return [{ ...s, claude: { ...c, interruption: null, pausedMs: c.pausedMs + (at - since) } }, [{ type: "speech.resume", say: c.say }]];
}

/** Whoever handed the words over (listen, the plugin hook, Voice Buddy), Claude has them now. */
function drained(s: OnCall, at: Ms): Step {
  if (!s.undelivered) return [s, []];
  const c = s.claude;
  const taken = { ...s, undelivered: false };
  if (c.kind === "idle" || c.kind === "thinking") return [{ ...taken, claude: thinking(s, at) }, []];
  return [{ ...taken, claude: { ...c, owesReply: true } }, []];
}

function tick(s: OnCall, at: Ms): Step {
  if (at - s.lastActivityAt >= s.policy.idleMs) return end(s, "idle");
  const c = s.claude;
  if (c.kind !== "thinking") return settle(s, at);
  if (at - c.since >= THINKING_MAX_MS) return [{ ...s, claude: IDLE }, []];
  if (s.user === "talking" || at - c.lastTickAt < THINKING_EVERY_MS) return [s, []];
  return [{ ...s, claude: { ...c, lastTickAt: at } }, [{ type: "cue", sound: "thinking-tick" }]];
}

function end(s: OnCall, reason: EndReason): Step {
  const c = s.claude;
  // A paused reply must not stay paused. One that is playing finishes: Claude's goodbye.
  const paused: Effect[] = c.kind === "speaking" && c.interruption ? [{ type: "speech.stop", say: c.say }] : [];
  const queued = c.kind === "speaking" || c.kind === "held" ? drop(c.queue) : [];
  return [{ phase: "off" }, [...paused, ...queued, { type: "teardown", reason }]];
}
