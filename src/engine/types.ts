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
 *   1. explosion: any value outside its `limit`, an active unresolved REAL
 *      fault whose severity is "explode", or a value outside `nominal` (but
 *      inside `limit`) whose `atT0` is "explode".
 *   2. pad_abort: an active unresolved REAL fault with severity "abort", or any
 *      value outside `nominal` (but inside `limit`) whose `atT0` is "abort"
 *      (the default). Engines shut down at ignition; the rocket survives and
 *      needs repair.
 *   3. otherwise, if a required step is undone or a poll is not closed all-go,
 *      the launch does not happen: automatic hold with the clock set back to
 *      T-1 s (tMs = -1000). Resuming runs the clock into T-0 again and
 *      re-evaluates, so the crew can fix things late; values keep drifting.
 *   4. otherwise (every requirement met, i.e. launch authority was given),
 *      scrub: any value outside `nominal` (but inside `limit`) whose `atT0` is
 *      "scrub" (weather). The crew launched anyway, but the vehicle stays on
 *      the pad: outcome "scrub", reasons "<Role label> outside launch criteria
 *      at T-0" (e.g. "Weather outside launch criteria at T-0") then one line
 *      per value; emitted as a `scrub` event (no role) then `outcome`.
 *      "scrub" sits BELOW the requirements hold, not above it: a scrub on
 *      weather only makes sense once the crew has actually cleared the
 *      launch; with a requirement unmet the count never reaches a launch
 *      decision and the T-1 hold gives the crew time to fix it (the weather
 *      keeps drifting and is re-evaluated on resume).
 *   5. otherwise success (or, with `ascentSec`, liftoff: see Ascent below).
 * Outcome kinds: "success" | "scrub" | "pad_abort" | "explosion" | "terminated" |
 * "range_violation" (the last two only from ascent, below). A scrub comes
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
 * Weather fronts. A ValueDef with `fronts: { everySec, driftPerSec: [min,max] }`
 * changes its own drift rate at every `everySec` of ELAPSED time (State.elapsedMs,
 * so fronts keep arriving during holds: weather does not stop for a hold).
 * `init` pre-rolls the whole schedule from the seeded PRNG (after every fault,
 * one draw per front, values in sequence order, so a sequence with no fronts
 * rolls exactly what it always did): State.fronts[valueId] = [{ at: elapsedMs,
 * rate }] for at = everySec, 2*everySec, ... covering countdownSec +
 * holdBudgetSec plus two spare fronts; rate is uniform in [min, max]. Past the
 * last front the final rate persists. `driftPerSec` is the rate before the
 * first front (use 0). Step effects may `set` such a value but may not set its
 * `driftPerSec` (the validator refuses), and fault effects add on top as for
 * any value. State.frontIdx[valueId] counts fronts already applied. The
 * schedule never reaches a view or a client.
 *
 * Granularity independence. With no actions between them, tick(tick(s,a),b)
 * deep-equals tick(s,b). The interval is split at fault activations, step and
 * poll window closes, T-0 and (on the elapsed clock, in count AND hold) every
 * front; at a front the value is re-anchored at that exact instant and the
 * new rate takes over. Windows are half-open: ready while
 * open <= t < close; at t == close an undone step is missed.
 *
 * Ascent and the range. A sequence with `ascentSec` does not end at a
 * successful T-0 (ladder step 5 above): phase becomes "ascent", the clock keeps
 * running as T+ (tMs > 0, always counting), and the mission is decided at
 * T+ascentSec. Holds are impossible: hold/resume/scrub and every step/poll
 * action are rejected with a clear error. A sequence without `ascentSec` ends
 * at T-0 exactly as before. In ascent:
 *   - Anomalies (`Sequence.anomalies`) are pre-rolled by `init` AFTER the
 *     faults and the fronts, three draws each, so no other sequence's dice
 *     move. scheduledT is in T+ ms. At that instant the anomaly activates and
 *     emits `anomaly_active` (role = the value's owner, data.real). The range
 *     console then shows the anomaly label as a caution (real or glitch alike,
 *     until the mission ends); the cross-check console reads "abnormal" iff
 *     the anomaly is real and active.
 *   - Value shape. An anomaly adds to its value's drift rate. A REAL anomaly
 *     adds +driftPerSec from activation on (the value runs towards its limit).
 *     A GLITCH adds +driftPerSec for GLITCH_OUT_SEC (8 s), then -driftPerSec
 *     for another 8 s, then nothing: a symmetric triangle peaking at
 *     |driftPerSec| * 8 that returns exactly to where it started. The
 *     validator keeps that peak strictly inside the limit and the value's own
 *     drift at 0, so a glitch can never end the mission. Both shapes are
 *     piecewise linear in elapsed time with rate changes at known instants
 *     (activation, +8 s, +16 s); ticks are split there and the value
 *     re-anchored, exactly as for fronts, which is what makes them independent
 *     of tick granularity. State.anomalies[id].stage records the running
 *     segment: "pending" | "out" | "back" | "over".
 *   - `terminate` ({ role: "range" } only, ascent only) ends the mission at
 *     once as outcome "terminated". The first reason says whether it was a
 *     correct call (a real anomaly is active) or a healthy vehicle destroyed (a
 *     glitch, or no anomaly, is active). Events: `terminate` (data.real,
 *     data.reason) then `outcome`.
 *   - Violation. If a REAL active anomaly's value reaches its `limit` (v <= low
 *     or v >= high) before termination, the mission ends at that exact instant
 *     (ticks are split at the crossing, found in whole ms) as "range_violation":
 *     "Vehicle left the safety corridor before termination".
 *   - Precedence at one instant in ascent: range_violation, then success at
 *     T+ascentSec, both before any action sent at that instant (apply() ticks
 *     first, so a terminate at the crossing instant is too late and is refused
 *     with "the mission is over").
 *   - Views. Only the range console is offered `terminateAvailable`, and only
 *     in ascent. `ascentSec` (static) rides on every view of an ascent
 *     sequence. The debrief gains `anomalies`. Old snapshots lack
 *     State.anomalies; sequences without anomalies never read it.
 */

export const ROLES = ["flight", "propulsion", "ground", "weather", "range"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  flight: "Flight Director",
  propulsion: "Propulsion",
  ground: "Ground Systems",
  weather: "Weather",
  range: "Range Safety",
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
  /**
   * Weather: the drift rate is re-drawn at every `everySec` of elapsed time
   * (holds included), uniform in `driftPerSec` [min, max]. See the header.
   */
  fronts?: { everySec: number; driftPerSec: [number, number] };
  /**
   * What being outside `nominal` (inside `limit`) does at T-0: "abort" (default,
   * pad abort), "explode" or "scrub" (weather). See the ladder in the header.
   */
  atT0?: "explode" | "abort" | "scrub";
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

/** Seconds a glitch drifts out, and the same again coming back (see the header). */
export const GLITCH_OUT_SEC = 8;

export interface AnomalyDef {
  id: string;
  label: string;
  /** T-plus seconds the anomaly may appear within, inside (0, ascentSec) */
  window: [number, number];
  /** probability the anomaly occurs at all this mission */
  chance: number;
  /** probability that, if it occurs, it is real (else a glitch) */
  realChance: number;
  /** id of a value owned by the range console */
  value: string;
  /** units/s added to the value while the anomaly runs; its sign picks the limit a real one heads for */
  driftPerSec: number;
  crossCheck?: { role: Role; label: string };
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
  /** T+ seconds of ascent after a good T-0; absent = the mission ends at T-0 */
  ascentSec?: number;
  anomalies?: AnomalyDef[];
}

// ------------------------------------------------------------------- state

export type Phase = "lobby" | "count" | "hold" | "ascent" | "done";
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
  kind: "success" | "scrub" | "pad_abort" | "explosion" | "terminated" | "range_violation";
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
  /** pre-rolled weather fronts per value: at = elapsedMs, rate = new drift (units/s) */
  fronts: Record<string, { at: number; rate: number }[]>;
  /** fronts already applied, per value in `fronts` */
  frontIdx: Record<string, number>;
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
  /** pre-rolled ascent anomalies (absent in snapshots saved before ascent existed) */
  anomalies: Record<
    string,
    {
      /** T+ ms; null = will not occur this mission */
      scheduledT: number | null;
      real: boolean;
      active: boolean;
      /** the running drift segment; see the header */
      stage: "pending" | "out" | "back" | "over";
      /** mission clock ms when it appeared */
      activeAt: number | null;
    }
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
  | { type: "terminate" }
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
  anomalies: {
    id: string;
    label: string;
    role: Role;
    scheduledT: number | null;
    real: boolean;
    active: boolean;
    /** mission clock ms it appeared, or null */
    activeAt: number | null;
    /** mission clock ms the range terminated the flight while it was active, or null */
    terminatedAt: number | null;
  }[];
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
  /** Range Safety only, and only in ascent: the terminate control */
  terminateAvailable?: true;
  /** static, present on every view of a sequence with an ascent */
  ascentSec?: number;
  /** only when phase is "done" */
  debrief?: Debrief;
}
