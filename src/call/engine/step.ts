/** Every rule of a call, as one pure function: no audio, no clock, no I/O (docs/specs/call-audio-redesign.md). */
import {
  BLIP_QUIET_MS,
  GIVE_UP_MS,
  THINKING_EVERY_MS,
  THINKING_MAX_MS,
  WORD_CHECK_MS,
  type ClaudeTurn,
  type Effect,
  type EndReason,
  type Event,
  type Heard,
  type Interruption,
  type Ms,
  type OnCall,
  type Policy,
  type SayId,
  type State,
  type TalkedOver,
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
    case "words.checked":
      return checked(state, event.words, event.quietMs, event.at);
    case "say.requested":
      return say(state, event.say, event.at);
    case "playback.ended":
      return state.claude.kind === "speaking" && state.claude.say === event.say
        ? next({ ...state, lastActivityAt: event.at }, state.claude.queue, state.claude.owesReply, event.at, state.claude.interruption)
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
  const over = claude.kind === "speaking" ? claude.interruption : null;
  if (over?.reply.kind === "paused" && user === "quiet" && !over.pending.length) wakes.push(over.reply.since + GIVE_UP_MS);
  if (over?.reply.kind === "ducked" && typeof over.reply.check === "number" && user === "talking") wakes.push(over.reply.check);
  return Math.min(...wakes);
}

/** Claude is free to speak: play the next say, hold it while the user talks on speakers, or go back to thinking. */
function next(s: OnCall, queue: readonly SayId[], owesReply: boolean, at: Ms, over: Interruption | null = null): Step {
  const [say, ...rest] = queue;
  if (say === undefined) return [{ ...s, claude: owesReply ? thinking(s, at) : IDLE }, []];
  // On speakers the mic goes deaf while Claude speaks, which would cut the user's sentence short.
  if (s.policy.interrupt === "none" && s.user === "talking") return [{ ...s, claude: { kind: "held", queue: [say, ...rest], owesReply } }, []];
  const speaking = { kind: "speaking", say, startedAt: at, pausedMs: 0, interruption: null, queue: rest, owesReply } as const;
  // A ducked reply ended under the user: the next one starts ducked, and the same transcript decides it.
  if (s.policy.interrupt === "duck" && over && (s.user === "talking" || over.pending.length)) {
    const reply: TalkedOver = { kind: "ducked", since: at, check: s.user === "talking" ? at + WORD_CHECK_MS : null };
    return [{ ...s, claude: { ...speaking, interruption: { ...over, at, reply } } }, [{ type: "speech.start", say }, { type: "speech.duck", say }]];
  }
  return [{ ...s, claude: speaking }, [{ type: "speech.start", say }]];
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
  if (s.policy.interrupt === "none" || c.kind !== "speaking") return [talking, []];
  const i = c.interruption ?? { at, pending: [], filler: false, reply: { kind: "playing" } };
  // Already paused or quieter: the transcript still out decides.
  if (i.reply.kind !== "playing") return [talking, []];
  const reply: TalkedOver = s.policy.interrupt === "pause" ? { kind: "paused", since: at } : { kind: "ducked", since: at, check: at + WORD_CHECK_MS };
  return [{ ...talking, claude: { ...c, interruption: { ...i, reply } } }, [{ type: reply.kind === "paused" ? "speech.pause" : "speech.duck", say: c.say }]];
}

/** The reply quieter and a word check due: ask the shell to look. */
function check(s: OnCall, at: Ms): Step | null {
  const c = s.claude;
  if (c.kind !== "speaking" || s.user !== "talking") return null;
  const reply = c.interruption?.reply;
  if (reply?.kind !== "ducked" || typeof reply.check !== "number" || at < reply.check) return null;
  return [talkedOver(s, { ...reply, check: "asked" }), [{ type: "words.check", say: c.say }]];
}

/** What the word check found decides how the reply sounds until the transcript comes. */
function checked(s: OnCall, words: boolean | null, quietMs: number, at: Ms): Step {
  const c = s.claude;
  if (c.kind !== "speaking") return [s, []];
  const reply = c.interruption?.reply;
  // A late answer: the transcript decided first, or a newer check is due.
  if (reply?.kind !== "ducked" || reply.check !== "asked") return [s, []];
  // Paused, not stopped: nothing is dropped on a partial.
  if (words) return [talkedOver(s, { kind: "paused", since: at }), [{ type: "speech.pause", say: c.say }]];
  // Whisper was busy or cold: the transcript decides, and the reply stays quieter until then.
  if (words === null) return [talkedOver(s, { ...reply, check: null }), []];
  if (s.user === "talking" && quietMs < BLIP_QUIET_MS && at - reply.since < GIVE_UP_MS) return [talkedOver(s, { ...reply, check: at + WORD_CHECK_MS }), []];
  return [talkedOver(s, { kind: "playing" }), [{ type: "speech.restore", say: c.say }]];
}

/** `s` with the talked-over reply now doing `reply`. */
function talkedOver(s: OnCall, reply: TalkedOver): OnCall {
  const c = s.claude;
  if (c.kind !== "speaking" || !c.interruption) return s;
  return { ...s, claude: { ...c, interruption: { ...c.interruption, reply } } };
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
  const i = c.interruption;
  return { ...s, claude: { ...c, interruption: { ...i, pending: i.pending.filter((u) => u !== utterance), filler: filler || i.filler } } };
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

/**
 * Back to normal once the user has stopped and said nothing real. A paused reply resumes after a
 * filler, or nothing within GIVE_UP_MS of being paused; a quieter one comes back up at once.
 */
function settle(s: OnCall, at: Ms): Step {
  const c = s.claude;
  if (c.kind !== "speaking" || !c.interruption || s.user === "talking" || c.interruption.pending.length) return [s, []];
  const { reply, filler } = c.interruption;
  const done = { ...s, claude: { ...c, interruption: null } };
  if (reply.kind === "playing") return [done, []];
  const say = c.say;
  if (reply.kind === "ducked") return [done, [{ type: "speech.restore", say }]];
  if (!filler && at - reply.since < GIVE_UP_MS) return [s, []];
  const resume: Effect[] = s.policy.interrupt === "duck" ? [{ type: "speech.restore", say }, { type: "speech.resume", say }] : [{ type: "speech.resume", say }];
  return [{ ...s, claude: { ...c, interruption: null, pausedMs: c.pausedMs + (at - reply.since) } }, resume];
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
  if (c.kind !== "thinking") return check(s, at) ?? settle(s, at);
  if (at - c.since >= THINKING_MAX_MS) return [{ ...s, claude: IDLE }, []];
  if (s.user === "talking" || at - c.lastTickAt < THINKING_EVERY_MS) return [s, []];
  return [{ ...s, claude: { ...c, lastTickAt: at } }, [{ type: "cue", sound: "thinking-tick" }]];
}

function end(s: OnCall, reason: EndReason): Step {
  const c = s.claude;
  // A paused or quieter reply must not stay so. One that is playing finishes: Claude's goodbye.
  const paused: Effect[] = c.kind === "speaking" && c.interruption && c.interruption.reply.kind !== "playing" ? [{ type: "speech.stop", say: c.say }] : [];
  const queued = c.kind === "speaking" || c.kind === "held" ? drop(c.queue) : [];
  return [{ phase: "off" }, [...paused, ...queued, { type: "teardown", reason }]];
}
