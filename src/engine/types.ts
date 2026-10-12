/*
 * Mission Control engine: the contract (read this before using the engine).
 *
 * The engine is pure. No I/O, no Date.now(), no Math.random(), no imports from
 * outside src/engine. Time arrives as `nowMs` arguments (any monotonic integer
 * millisecond clock; the server's choice). Randomness comes from a seeded
 * mulberry32 whose state lives in State.rng. State is plain JSON (snapshot it
 * to SQLite as-is). Every function returns new data and never mutates inputs.
 *
 *   parseSequence(raw: unknown): Sequence          (sequence.ts; throws SequenceError with a path)
 *   init(seq, seed): State                         phase "lobby"; every fault pre-rolled
 *   apply(seq, state, action, nowMs): ApplyResult  ticks to nowMs first, then applies
 *   tick(seq, state, nowMs): { state, events }     advance the clock and values only
 *   view(seq, state, role): ConsoleView            only what that console may see
 *
 * Units. Sequence JSON uses seconds ("T-minus": negative numbers, e.g. a step
 * window [-200, -60] is open from T-200 s until T-60 s). State uses integer
 * milliseconds for everything on the mission clock: tMs, atT, scheduledT.
 * tMs starts at -countdownSec * 1000 and rises to 0.
 *
 * Replaying: init(seq, seed) then the same timed actions give an identical
 * State, so a log of (action, nowMs) is a complete record of a mission.
 *
 * Phases. lobby -> count <-> hold -> done. `start` moves lobby -> count and
 * pins lastNowMs. While `count` the mission clock runs. While `hold` the clock
 * is frozen but VALUES KEEP DRIFTING (holding is safe but costly). `done` is
 * final (outcome set); nothing moves after it.
 *
 * Results. apply() returns { ok:true, state, events } or { ok:false, error,
 * state, events }. On failure `state` and `events` are what ticking to nowMs
 * produced BEFORE the action was rejected (it can contain an outcome or a
 * hold); persist them. A failed action itself changes nothing. For an action
 * rejected before any ticking (lobby, bad role, time going backwards), state is
 * the input unchanged and events is [].
 *
 * Events are for the log and the replay only. They carry real/glitch truth
 * (fault_active.data.real) so they must NOT be broadcast to clients; clients
 * get view(). Kinds: start, step_done, step_missed, fault_active,
 * fault_resolved, poll_opened, poll_report, poll_closed, poll_missed, hold,
 * resume, scrub, window_closed, outcome. `data.reason` on hold/scrub/
 * window_closed/outcome is human-readable.
 *
 * Differences from the planning brief (all additive or clarifying):
 *  - State gains `elapsedMs` (real running time, includes holds) and `anchors`
 *    (value at last rate change). Values are exact functions of these, which is
 *    what makes tick granularity-independent to the bit. `drift` holds the BASE
 *    rate (start value plus step effects); active real fault effects are added
 *    on top by the engine.
 *  - Poll status gains "missed" (window passed unclosed; can be completed late
 *    during the hold) and polls gain `history` (earlier rounds, see re-poll).
 *  - A poll that closed with any "nogo" can be re-opened by flight (poll_open)
 *    for a fresh round; the old reports move to `history`.
 *  - `after` may reference steps AND polls (one id namespace). A poll counts as
 *    done when closed with every report "go".
 *  - A fault's fixStep stays "locked" until that fault is active and
 *    unresolved. fixStep must belong to the fault's role and be required:false.
 *  - A missed step that is not required does not hold the mission.
 *  - The cross-check readout is always present on the cross-check console
 *    ("normal" until a real fault is active and unresolved, then "abnormal").
 *  - When phase is "done" a view also carries `debrief`, the full record
 *    (real vs glitch, reported vs showing); before that it never does.
 *  - ApplyResult failures carry state/events (see Results).
 *
 * T-0 (clock reaches 0 while counting): the outcome ladder. Worst first:
 *   1. explosion: any value outside its `limit`, or an active unresolved REAL
 *      fault whose severity is "explode".
 *   2. pad_abort: an active unresolved REAL fault with severity "abort", or any
 *      value outside `nominal` (but inside `limit`). Engines shut down at
 *      ignition; the rocket survives and needs repair.
 *   3. otherwise, if a required step is undone or a poll is not closed all-go,
 *      the launch does not happen: automatic hold with the clock set back to
 *      T-1 s (tMs = -1000). Resuming runs the clock into T-0 again and
 *      re-evaluates, so the crew can fix things late; values keep drifting.
 *   4. otherwise success.
 * Outcome kinds: "success" | "scrub" | "pad_abort" | "explosion". A scrub comes
 * from the Flight Director (action.reason, default "Scrubbed by the Flight
 * Director"; the HTTP layer never forwards a client reason), from the server
 * (crew lost contact) or from the launch window closing.
 *
 * Launch window. `Sequence.holdBudgetSec` is the total time the mission may
 * spend on hold. State.holdMs accumulates real time in the hold phase (the
 * clock is frozen, values drift). When it reaches the budget the interval is
 * split at that instant and the mission ends: events `window_closed` then
 * `outcome` (scrub, "Launch window closed after N holds").
 *
 * A seat's `showing` on a poll report is "caution" if its console had an active
 * unresolved fault, a value outside nominal, or a cross-check readout reading
 * "abnormal" at report time (a seat holding evidence about another seat's real
 * fault was shown it).
 *
 * Granularity independence. With no actions between them, tick(tick(s,a),b)
 * deep-equals tick(s,b). The interval is split at fault activations, step and
 * poll window closes, and T-0. Windows are half-open: ready while
 * open <= t < close; at t == close an undone step is missed.
 */

export const ROLES = ["flight", "propulsion", "ground"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  flight: "Flight Director",
  propulsion: "Propulsion",
  ground: "Ground Systems",
};

// ---------------------------------------------------------------- sequence

export interface ValueDef {
  role: Role;
  label: string;
  unit: string;
  start: number;
  driftPerSec: number;
  /** outside nominal = caution light */
  nominal: [number, number];
  /** outside limit at T-0 = failure */
  limit: [number, number];
}

export interface StepEffect {
  value: string;
  set?: number;
  driftPerSec?: number;
}

export interface StepDef {
  id: string;
  role: Role;
  label: string;
  after: string[];
  /** T-minus seconds, negative, e.g. [-200, -60] */
  window?: [number, number];
  effects?: StepEffect[];
  required: boolean;
}

export interface PollDef {
  id: string;
  label: string;
  after: string[];
  window: [number, number];
}

export interface FaultDef {
  id: string;
  role: Role;
  label: string;
  /** T-minus seconds the fault may activate within */
  window: [number, number];
  /** probability the fault occurs at all this mission */
  chance: number;
  /** probability that, if it occurs, it is real (else a glitch) */
  realChance: number;
  /** applied (added to the drift rate) while a REAL fault is active */
  effect?: { value: string; driftPerSec: number };
  crossCheck?: { role: Role; label: string };
  fixStep?: string;
  /** what a REAL fault left unresolved does at T-0: pad abort or explosion */
  severity: "abort" | "explode";
}

export interface Sequence {
  id: string;
  name: string;
  countdownSec: number;
  /** total seconds the mission may spend in hold before the launch window closes */
  holdBudgetSec: number;
  roles: Role[];
  values: Record<string, ValueDef>;
  steps: StepDef[];
  polls: PollDef[];
  faults: FaultDef[];
}

// ------------------------------------------------------------------- state

export type Phase = "lobby" | "count" | "hold" | "done";
export type StepStatus = "locked" | "ready" | "done" | "missed";
export type PollStatus = "locked" | "ready" | "open" | "closed" | "missed";
export type Report = "go" | "nogo";
export type Showing = "nominal" | "caution";

export interface PollReport {
  report: Report;
  showing: Showing;
  atT: number;
}
export type PollReports = Partial<Record<Role, PollReport>>;

export interface Outcome {
  kind: "success" | "scrub" | "pad_abort" | "explosion";
  reasons: string[];
  atT: number;
}

export interface State {
  seqId: string;
  seed: number;
  /** mulberry32 state */
  rng: number;
  phase: Phase;
  /** mission clock, ms: starts at -countdownSec*1000, rises to 0 */
  tMs: number;
  /** nowMs at the last tick; null until started */
  lastNowMs: number | null;
  /** real ms since start, running through holds too; drives value drift */
  elapsedMs: number;
  holds: number;
  /** total real ms spent in hold; the launch window closes at holdBudgetSec */
  holdMs: number;
  steps: Record<string, { status: StepStatus; atT?: number }>;
  values: Record<string, number>;
  /** base drift rate per value (units/s), before active fault effects */
  drift: Record<string, number>;
  /** value and elapsedMs at its last rate change */
  anchors: Record<string, { v: number; e: number }>;
  faults: Record<
    string,
    {
      /** null = will not occur this mission */
      scheduledT: number | null;
      real: boolean;
      active: boolean;
      resolved: boolean;
    }
  >;
  polls: Record<
    string,
    { status: PollStatus; reports: PollReports; history: PollReports[] }
  >;
  outcome: Outcome | null;
}

// ------------------------------------------------------------ actions/events

export type Action = { role: Role } & (
  | { type: "start" }
  | { type: "step"; stepId: string }
  | { type: "hold" }
  | { type: "resume" }
  | { type: "scrub"; reason?: string }
  | { type: "poll_open"; pollId: string }
  | { type: "poll_report"; pollId: string; report: Report }
);

export interface EngineEvent {
  kind: string;
  atT: number;
  role?: Role;
  data?: Record<string, unknown>;
}

export type TickResult = { state: State; events: EngineEvent[] };
export type ApplyResult =
  | { ok: true; state: State; events: EngineEvent[] }
  | { ok: false; error: string; state: State; events: EngineEvent[] };

// -------------------------------------------------------------------- views

export interface ConsoleStep {
  id: string;
  label: string;
  status: StepStatus;
  required: boolean;
  window: [number, number] | null;
  /** unfinished prerequisites; label is null when it lives on another console */
  waitingOn: { role: Role; label: string | null }[];
}

export interface ConsoleValue {
  id: string;
  label: string;
  unit: string;
  value: number;
  nominal: [number, number];
  limit: [number, number];
  caution: boolean;
}

export interface ConsoleCrossCheck {
  label: string;
  reading: "normal" | "abnormal";
}

export interface ConsolePoll {
  id: string;
  label: string;
  status: PollStatus;
  window: [number, number];
  /** what each seat said (never what it was showing) */
  reports: Partial<Record<Role, Report>>;
  /** roles yet to report while the poll is open */
  pending: Role[];
  /** the viewer's own report this round, null if none */
  myReport: Report | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
  role: Role;
  status: StepStatus;
  required: boolean;
}

export interface Debrief {
  steps: { id: string; label: string; role: Role; status: StepStatus; atT: number | null }[];
  polls: {
    id: string;
    label: string;
    status: PollStatus;
    reports: PollReports;
    history: PollReports[];
  }[];
  faults: {
    id: string;
    label: string;
    role: Role;
    scheduledT: number | null;
    real: boolean;
    active: boolean;
    resolved: boolean;
  }[];
  values: { id: string; label: string; role: Role; unit: string; value: number; limit: [number, number] }[];
}

export interface ConsoleView {
  role: Role;
  phase: Phase;
  tMs: number;
  holds: number;
  /** hold time left before the launch window closes */
  holdLeftMs: number;
  outcome: Outcome | null;
  steps: ConsoleStep[];
  values: ConsoleValue[];
  /** labels of this console's active, unresolved faults; never real/glitch */
  cautions: string[];
  crossChecks: ConsoleCrossCheck[];
  polls: ConsolePoll[];
  /** flight only: every step with its role and status, no values/faults */
  checklist?: ChecklistItem[];
  /** only when phase is "done" */
  debrief?: Debrief;
}
