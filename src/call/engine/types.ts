/**
 * A call as data: what `step` (step.ts) reads and returns. Pure: this directory imports nothing
 * outside itself and reads no clock (test/engine.test.mjs checks both).
 *
 * Privacy: no State, Event or Effect field carries text or audio, only ids, numbers, booleans and
 * the enums below. The shell (src/call/session.ts) keeps the words and refers to them by id, so
 * every (event, effects) pair goes to the flight recorder as it is.
 */

/** Wall-clock ms. Every event carries one. */
export type Ms = number;
/** One `say`. The shell holds its text. */
export type SayId = number & { readonly __say: unique symbol };
/** One thing the user said. The shell holds its transcript. */
export type UtteranceId = number & { readonly __utterance: unique symbol };

/** How an utterance ended. "cut": the mic stopped hearing the user mid-sentence (our reply on speakers, or mute). */
export const UTTERANCE_ENDINGS = ["end-of-turn", "max-duration", "cut"] as const;
/** Sound that came to nothing: speech too short to count, or none at all. */
export const NOTHING_SAID = ["blip", "no-speech"] as const;
/** What a transcript is (words.ts). "empty": nothing in it. */
export const HEARD = ["words", "filler", "hang-up", "empty"] as const;
export type Heard = (typeof HEARD)[number];
/** Ends asked for from outside: by Claude or a shutdown, the session closing, the recorder failing. */
export const END_REQUESTS = ["requested", "session-ended", "mic-lost"] as const;
export const END_REASONS = [...END_REQUESTS, "hang-up", "idle"] as const;
export type EndReason = (typeof END_REASONS)[number];
export const CUES = ["thinking-tick"] as const;

export interface Policy {
  /**
   * What talking over a reply does. "pause" (headphones): the reply pauses, and the transcript
   * decides whether it stops. "none" (speakers): the mic can't hear the user while a reply plays,
   * so a reply waits for them to finish their sentence.
   */
  readonly interrupt: "pause" | "none";
  /** Tick while Claude thinks. */
  readonly thinkingTick: boolean;
  /** The call ends after this long without a word either way. */
  readonly idleMs: number;
}

/** After talking over Claude, nothing real said within this long resumes the reply (LiveKit's 2 s). */
export const GIVE_UP_MS = 2000;
/** While Claude thinks: a tick this often, for at most this long. */
export const THINKING_EVERY_MS = 1500;
export const THINKING_MAX_MS = 10_000;

export type State = { readonly phase: "off" } | OnCall;

export interface OnCall {
  readonly phase: "on";
  readonly policy: Policy;
  /** When a reply last ended or the user's words last arrived. */
  readonly lastActivityAt: Ms;
  readonly user: UserTurn;
  readonly claude: ClaudeTurn;
  /** Things the user said that speech to text failed on, since the last one it heard. */
  readonly missed: number;
  /** Words are in the inbox that nobody has handed to Claude yet. */
  readonly undelivered: boolean;
}

/** "talking": from the onset of speech until the utterance ends. */
export type UserTurn = "quiet" | "talking";

export type ClaudeTurn =
  | { readonly kind: "idle" }
  /** The user's words reached Claude, which hasn't spoken since. */
  | { readonly kind: "thinking"; readonly since: Ms; readonly lastTickAt: Ms }
  /** Says waiting for the user to finish their sentence (interrupt "none"), oldest first. */
  | ({ readonly kind: "held"; readonly queue: readonly [SayId, ...SayId[]] } & Saying)
  | Speaking;

type Speaking = {
  readonly kind: "speaking";
  readonly say: SayId;
  readonly startedAt: Ms;
  /** How long earlier interruptions paused it. */
  readonly pausedMs: number;
  readonly interruption: Interruption | null;
  /** Says to play after it, oldest first. */
  readonly queue: readonly SayId[];
} & Saying;

interface Saying {
  /** The user's words reached Claude meanwhile: it is thinking once the says have played. */
  readonly owesReply: boolean;
}

/** The user talking over a reply, which stays paused until their words stop it or it resumes. */
export interface Interruption {
  readonly at: Ms;
  /** Its utterances still being transcribed. */
  readonly pending: readonly UtteranceId[];
  /** One of its utterances was only a filler, or nothing: the reply resumes once the user is done. */
  readonly filler: boolean;
}

export type Event = { readonly at: Ms } & (
  /** The user has talked for BARGE_IN_MS. */
  | { readonly type: "speech.onset" }
  | { readonly type: "speech.dropped"; readonly reason: (typeof NOTHING_SAID)[number] }
  | { readonly type: "utterance.ended"; readonly utterance: UtteranceId; readonly reason: (typeof UTTERANCE_ENDINGS)[number] }
  | { readonly type: "transcribed"; readonly utterance: UtteranceId; readonly heard: Heard }
  | { readonly type: "transcribe.failed"; readonly utterance: UtteranceId }
  | { readonly type: "say.requested"; readonly say: SayId }
  /** It finished, was stopped or failed. */
  | { readonly type: "playback.ended"; readonly say: SayId }
  /** `listen`, the plugin hook or Voice Buddy took the user's words. */
  | { readonly type: "inbox.drained" }
  | { readonly type: "end.requested"; readonly reason: (typeof END_REQUESTS)[number] }
  /** The wake nextWake() asked for. Harmless at any other time. */
  | { readonly type: "tick" }
);

export type Effect =
  | { readonly type: "speech.start"; readonly say: SayId }
  | { readonly type: "speech.pause"; readonly say: SayId }
  | { readonly type: "speech.resume"; readonly say: SayId }
  | { readonly type: "speech.stop"; readonly say: SayId }
  /** Queued, never played. */
  | { readonly type: "speech.drop"; readonly say: SayId }
  /**
   * Put the utterance in the inbox. `interrupted`: its words stopped that reply after `playedMs` of it.
   * `missed`: how many things said before it were lost.
   */
  | { readonly type: "deliver"; readonly utterance: UtteranceId; readonly interrupted: { readonly say: SayId; readonly playedMs: number } | null; readonly missed: number }
  | { readonly type: "cue"; readonly sound: (typeof CUES)[number] }
  | { readonly type: "teardown"; readonly reason: EndReason };

/** A variant's string fields, and the values each may take. */
type Strings<V> = { readonly [K in keyof V as K extends "type" ? never : V[K] extends string ? K : never]: readonly V[K][] };
type StringTable<U extends { type: string }> = { readonly [T in U["type"]]: Strings<Extract<U, { type: T }>> };

/**
 * Every event and effect type with its string fields. The flight recorder's allowlist is built from
 * these two tables, and a variant or a string field missing here doesn't compile.
 */
export const EVENT_STRINGS = {
  "speech.onset": {},
  "speech.dropped": { reason: NOTHING_SAID },
  "utterance.ended": { reason: UTTERANCE_ENDINGS },
  transcribed: { heard: HEARD },
  "transcribe.failed": {},
  "say.requested": {},
  "playback.ended": {},
  "inbox.drained": {},
  "end.requested": { reason: END_REQUESTS },
  tick: {},
} as const satisfies StringTable<Event>;

export const EFFECT_STRINGS = {
  "speech.start": {},
  "speech.pause": {},
  "speech.resume": {},
  "speech.stop": {},
  "speech.drop": {},
  deliver: {},
  cue: { sound: CUES },
  teardown: { reason: END_REASONS },
} as const satisfies StringTable<Effect>;
