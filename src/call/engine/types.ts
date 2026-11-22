// A call as data, the pure engine's state, events and effects. See docs/specs/call-mode.md.

// Wall-clock ms.
export type Ms = number;
// Privacy: the shell holds the text behind each id; no engine field carries words or audio.
export type SayId = number & { readonly __say: unique symbol };
export type UtteranceId = number & { readonly __utterance: unique symbol };

export const UTTERANCE_ENDINGS = ["end-of-turn", "max-duration", "cut"] as const;
export const NOTHING_SAID = ["blip", "no-speech"] as const;
export const HEARD = ["words", "filler", "hang-up", "empty"] as const;
export type Heard = (typeof HEARD)[number];
export const END_REQUESTS = ["requested", "session-ended", "mic-lost"] as const;
export const END_REASONS = [...END_REQUESTS, "hang-up", "idle"] as const;
export type EndReason = (typeof END_REASONS)[number];
export const CUES = ["thinking-tick"] as const;

export interface Policy {
  readonly interrupt: "duck" | "pause" | "none";
  readonly thinkingTick: boolean;
  readonly idleMs: number;
}

export const GIVE_UP_MS = 2000;
export const WORD_CHECK_MS = 700;
export const BLIP_QUIET_MS = 300;
export const THINKING_EVERY_MS = 1500;
export const THINKING_MAX_MS = 10_000;

export type State = { readonly phase: "off" } | OnCall;

export interface OnCall {
  readonly phase: "on";
  readonly policy: Policy;
  readonly lastActivityAt: Ms;
  readonly user: UserTurn;
  readonly claude: ClaudeTurn;
  readonly missed: number;
  readonly undelivered: boolean;
}

export type UserTurn = "quiet" | "talking";

export type ClaudeTurn =
  | { readonly kind: "idle" }
  | { readonly kind: "thinking"; readonly since: Ms; readonly lastTickAt: Ms }
  | ({ readonly kind: "held"; readonly queue: readonly [SayId, ...SayId[]] } & Saying)
  | Speaking;

type Speaking = {
  readonly kind: "speaking";
  readonly say: SayId;
  readonly startedAt: Ms;
  readonly pausedMs: number;
  readonly interruption: Interruption | null;
  readonly queue: readonly SayId[];
} & Saying;

interface Saying {
  readonly owesReply: boolean;
}

export interface Interruption {
  readonly at: Ms;
  readonly pending: readonly UtteranceId[];
  readonly filler: boolean;
  readonly reply: TalkedOver;
}

export type TalkedOver =
  | { readonly kind: "ducked"; readonly since: Ms; readonly check: Ms | "asked" | null }
  | { readonly kind: "paused"; readonly since: Ms }
  | { readonly kind: "playing" };

export type Event = { readonly at: Ms } & (
  | { readonly type: "speech.onset" }
  | { readonly type: "speech.dropped"; readonly reason: (typeof NOTHING_SAID)[number] }
  | { readonly type: "utterance.ended"; readonly utterance: UtteranceId; readonly reason: (typeof UTTERANCE_ENDINGS)[number] }
  | { readonly type: "transcribed"; readonly utterance: UtteranceId; readonly heard: Heard }
  | { readonly type: "transcribe.failed"; readonly utterance: UtteranceId }
  | { readonly type: "words.checked"; readonly words: boolean | null; readonly quietMs: number }
  | { readonly type: "say.requested"; readonly say: SayId }
  | { readonly type: "playback.ended"; readonly say: SayId }
  | { readonly type: "inbox.drained" }
  | { readonly type: "end.requested"; readonly reason: (typeof END_REQUESTS)[number] }
  | { readonly type: "tick" }
);

export type Effect =
  | { readonly type: "speech.start"; readonly say: SayId }
  | { readonly type: "speech.duck"; readonly say: SayId }
  | { readonly type: "speech.restore"; readonly say: SayId }
  | { readonly type: "speech.pause"; readonly say: SayId }
  | { readonly type: "speech.resume"; readonly say: SayId }
  | { readonly type: "speech.stop"; readonly say: SayId }
  | { readonly type: "speech.drop"; readonly say: SayId }
  | { readonly type: "deliver"; readonly utterance: UtteranceId; readonly interrupted: { readonly say: SayId; readonly playedMs: number } | null; readonly missed: number }
  | { readonly type: "words.check"; readonly say: SayId }
  | { readonly type: "cue"; readonly sound: (typeof CUES)[number] }
  | { readonly type: "teardown"; readonly reason: EndReason };

type Strings<V> = { readonly [K in keyof V as K extends "type" ? never : V[K] extends string ? K : never]: readonly V[K][] };
type StringTable<U extends { type: string }> = { readonly [T in U["type"]]: Strings<Extract<U, { type: T }>> };

// The flight recorder's allowlist is built from these tables.
export const EVENT_STRINGS = {
  "speech.onset": {},
  "speech.dropped": { reason: NOTHING_SAID },
  "utterance.ended": { reason: UTTERANCE_ENDINGS },
  transcribed: { heard: HEARD },
  "transcribe.failed": {},
  "words.checked": {},
  "say.requested": {},
  "playback.ended": {},
  "inbox.drained": {},
  "end.requested": { reason: END_REQUESTS },
  tick: {},
} as const satisfies StringTable<Event>;

export const EFFECT_STRINGS = {
  "speech.start": {},
  "speech.duck": {},
  "speech.restore": {},
  "speech.pause": {},
  "speech.resume": {},
  "speech.stop": {},
  "speech.drop": {},
  deliver: {},
  "words.check": {},
  cue: { sound: CUES },
  teardown: { reason: END_REASONS },
} as const satisfies StringTable<Effect>;
