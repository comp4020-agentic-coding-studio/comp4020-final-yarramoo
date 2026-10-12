import { nextRandom } from "./rng.ts";
import { ROLE_LABELS } from "./types.ts";
import type {
  Action,
  ApplyResult,
  EngineEvent,
  Role,
  Sequence,
  State,
  StepDef,
  TickResult,
} from "./types.ts";

// Contract and semantics: see the header of types.ts.

const ms = (sec: number): number => Math.round(sec * 1000);

interface Ctx {
  seq: Sequence;
  s: State;
  ev: EngineEvent[];
}

function emit(c: Ctx, kind: string, role?: Role, data?: Record<string, unknown>): void {
  const e: EngineEvent = { kind, atT: c.s.tMs };
  if (role) e.role = role;
  if (data) e.data = data;
  c.ev.push(e);
}

// ------------------------------------------------------------------ values

/** Base drift plus the effects of active, unresolved REAL faults. */
function effectiveRate(seq: Sequence, s: State, valueId: string): number {
  let rate = s.drift[valueId]!;
  for (const f of seq.faults) {
    const fs = s.faults[f.id]!;
    if (f.effect && f.effect.value === valueId && fs.active && fs.real && !fs.resolved) {
      rate += f.effect.driftPerSec;
    }
  }
  return rate;
}

function computeValue(seq: Sequence, s: State, id: string): number {
  const a = s.anchors[id]!;
  return a.v + (effectiveRate(seq, s, id) * (s.elapsedMs - a.e)) / 1000;
}

function syncValues(seq: Sequence, s: State): void {
  for (const id of Object.keys(seq.values)) s.values[id] = computeValue(seq, s, id);
}

/** Fix every value at its current reading; call before changing any rate. */
function rebase(seq: Sequence, s: State): void {
  for (const id of Object.keys(seq.values)) {
    s.anchors[id] = { v: computeValue(seq, s, id), e: s.elapsedMs };
  }
  syncValues(seq, s);
}

function outsideNominal(seq: Sequence, s: State, id: string): boolean {
  const d = seq.values[id]!;
  const v = s.values[id]!;
  return v < d.nominal[0] || v > d.nominal[1];
}

/** True when this role's console would show a caution light right now. */
function consoleShowsCaution(seq: Sequence, s: State, role: Role): boolean {
  for (const f of seq.faults) {
    const fs = s.faults[f.id]!;
    if (f.role === role && fs.active && !fs.resolved) return true;
  }
  for (const [id, d] of Object.entries(seq.values)) {
    if (d.role === role && outsideNominal(seq, s, id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- readiness

function reporters(seq: Sequence): Role[] {
  return seq.roles.filter((r) => r !== "flight");
}

function pollAllGo(seq: Sequence, s: State, pollId: string): boolean {
  const p = s.polls[pollId]!;
  return (
    p.status === "closed" &&
    reporters(seq).every((r) => p.reports[r]?.report === "go")
  );
}

function isComplete(seq: Sequence, s: State, id: string): boolean {
  if (s.steps[id]) return s.steps[id]!.status === "done";
  return pollAllGo(seq, s, id);
}

function inWindow(s: State, w: [number, number] | undefined): boolean {
  return !w || (s.tMs >= ms(w[0]) && s.tMs < ms(w[1]));
}

function fixesFaults(seq: Sequence, stepId: string) {
  return seq.faults.filter((f) => f.fixStep === stepId);
}

/** Prerequisites met (ignoring the window); a fix step also needs its fault. */
function stepUnlocked(seq: Sequence, s: State, step: StepDef): boolean {
  if (!step.after.every((a) => isComplete(seq, s, a))) return false;
  const fixes = fixesFaults(seq, step.id);
  if (fixes.length > 0) {
    return fixes.some((f) => s.faults[f.id]!.active && !s.faults[f.id]!.resolved);
  }
  return true;
}

function refresh(seq: Sequence, s: State): void {
  if (s.phase === "lobby" || s.phase === "done") return;
  for (const step of seq.steps) {
    const st = s.steps[step.id]!;
    if (st.status !== "locked" && st.status !== "ready") continue;
    st.status = stepUnlocked(seq, s, step) && inWindow(s, step.window) ? "ready" : "locked";
  }
  for (const poll of seq.polls) {
    const p = s.polls[poll.id]!;
    if (p.status !== "locked" && p.status !== "ready") continue;
    p.status =
      poll.after.every((a) => isComplete(seq, s, a)) && inWindow(s, poll.window)
        ? "ready"
        : "locked";
  }
}

// ----------------------------------------------------------------- outcomes

function enterHold(c: Ctx, reason: string): void {
  c.s.phase = "hold";
  c.s.holds += 1;
  emit(c, "hold", undefined, { reason });
}

function finish(c: Ctx, kind: "success" | "explosion" | "scrub", reasons: string[]): void {
  c.s.phase = "done";
  c.s.outcome = { kind, reasons, atT: c.s.tMs };
  emit(c, "outcome", undefined, { kind, reasons });
}

function evaluateT0(c: Ctx): void {
  const { seq, s } = c;
  syncValues(seq, s);
  const blast: string[] = [];
  for (const f of seq.faults) {
    const fs = s.faults[f.id]!;
    if (fs.active && fs.real && !fs.resolved) {
      blast.push(`${ROLE_LABELS[f.role]}: "${f.label}" was a real fault and was never resolved`);
    }
  }
  for (const [id, d] of Object.entries(seq.values)) {
    const v = s.values[id]!;
    if (v < d.limit[0] || v > d.limit[1]) {
      blast.push(
        `${ROLE_LABELS[d.role]}: ${d.label} read ${v.toFixed(1)} ${d.unit} at T-0, outside the limit ${d.limit[0]} to ${d.limit[1]}`,
      );
    }
  }
  if (blast.length > 0) return finish(c, "explosion", blast);

  const unmet: string[] = [];
  for (const step of seq.steps) {
    if (step.required && s.steps[step.id]!.status !== "done") {
      unmet.push(`required step not done: ${step.label}`);
    }
  }
  for (const poll of seq.polls) {
    const p = s.polls[poll.id]!;
    if (p.status !== "closed") unmet.push(`poll not completed: ${poll.label}`);
    else if (!pollAllGo(seq, s, poll.id)) unmet.push(`poll closed with a no-go: ${poll.label}`);
  }
  if (unmet.length > 0) {
    // A hold at T-0 is not possible, so the clock steps back to T-1 s. Resuming
    // runs into T-0 again and re-evaluates.
    s.tMs = -1000;
    return enterHold(c, `T-0 reached with unmet requirements: ${unmet.join("; ")}`);
  }
  finish(c, "success", [
    "All required steps done, every poll closed with all seats go, no unresolved real fault, every value inside its limit",
  ]);
}

/**
 * Process everything that depends on the clock sitting at s.tMs: fault
 * activations, missed windows, T-0. Idempotent, so safe to call anywhere.
 */
function settle(c: Ctx): void {
  const { seq, s } = c;
  for (const f of seq.faults) {
    const fs = s.faults[f.id]!;
    if (!fs.active && !fs.resolved && fs.scheduledT !== null && s.tMs >= fs.scheduledT) {
      rebase(seq, s);
      fs.active = true;
      emit(c, "fault_active", f.role, { faultId: f.id, real: fs.real });
    }
  }
  const holdReasons: string[] = [];
  for (const step of seq.steps) {
    const st = s.steps[step.id]!;
    if ((st.status === "locked" || st.status === "ready") && step.window && s.tMs >= ms(step.window[1])) {
      st.status = "missed";
      emit(c, "step_missed", step.role, { stepId: step.id, required: step.required });
      if (step.required) holdReasons.push(`missed step: ${step.label}`);
    }
  }
  for (const poll of seq.polls) {
    const p = s.polls[poll.id]!;
    if (
      (p.status === "locked" || p.status === "ready" || p.status === "open") &&
      s.tMs >= ms(poll.window[1])
    ) {
      p.status = "missed";
      emit(c, "poll_missed", "flight", { pollId: poll.id });
      holdReasons.push(`poll window passed: ${poll.label}`);
    }
  }
  if (holdReasons.length > 0 && s.phase === "count") enterHold(c, holdReasons.join("; "));
  if (s.phase === "count" && s.tMs >= 0) evaluateT0(c);
  refresh(seq, s);
}

// --------------------------------------------------------------------- tick

function nextBoundary(c: Ctx): number {
  const { seq, s } = c;
  let next = 0; // T-0
  const consider = (t: number | null): void => {
    if (t !== null && t > s.tMs && t < next) next = t;
  };
  for (const f of seq.faults) {
    const fs = s.faults[f.id]!;
    if (!fs.active && !fs.resolved) consider(fs.scheduledT);
  }
  for (const step of seq.steps) {
    const st = s.steps[step.id]!;
    if ((st.status === "locked" || st.status === "ready") && step.window) consider(ms(step.window[1]));
  }
  for (const poll of seq.polls) {
    const p = s.polls[poll.id]!;
    if (p.status === "locked" || p.status === "ready" || p.status === "open") consider(ms(poll.window[1]));
  }
  return next;
}

function runTo(c: Ctx, nowMs: number): void {
  const { seq, s } = c;
  if (s.lastNowMs === null || (s.phase !== "count" && s.phase !== "hold") || nowMs <= s.lastNowMs) return;
  let remaining = nowMs - s.lastNowMs;
  while (remaining > 0 && (s.phase === "count" || s.phase === "hold")) {
    if (s.phase === "hold") {
      s.elapsedMs += remaining; // clock frozen, values keep drifting
      remaining = 0;
      break;
    }
    const step = Math.max(1, Math.min(remaining, nextBoundary(c) - s.tMs));
    s.tMs += step;
    s.elapsedMs += step;
    remaining -= step;
    syncValues(seq, s);
    settle(c);
  }
  // If the mission ended mid-interval, lastNowMs stops where it ended, so the
  // result does not depend on how the interval was chopped up.
  s.lastNowMs = nowMs - remaining;
  syncValues(seq, s);
}

export function tick(seq: Sequence, state: State, nowMs: number): TickResult {
  const c: Ctx = { seq, s: structuredClone(state), ev: [] };
  runTo(c, Math.round(nowMs));
  return { state: c.s, events: c.ev };
}

// --------------------------------------------------------------------- init

export function init(seq: Sequence, seed: number): State {
  let rng = seed | 0;
  const roll = (): number => {
    const r = nextRandom(rng);
    rng = r.state;
    return r.value;
  };
  const s: State = {
    seqId: seq.id,
    seed,
    rng,
    phase: "lobby",
    tMs: -seq.countdownSec * 1000,
    lastNowMs: null,
    elapsedMs: 0,
    holds: 0,
    steps: {},
    values: {},
    drift: {},
    anchors: {},
    faults: {},
    polls: {},
    outcome: null,
  };
  for (const step of seq.steps) s.steps[step.id] = { status: "locked" };
  for (const poll of seq.polls) s.polls[poll.id] = { status: "locked", reports: {}, history: [] };
  for (const [id, d] of Object.entries(seq.values)) {
    s.values[id] = d.start;
    s.drift[id] = d.driftPerSec;
    s.anchors[id] = { v: d.start, e: 0 };
  }
  // Pre-roll every fault, always three draws each, so a mission's outcome does
  // not depend on when it is ticked and editing one fault never reshuffles
  // the others' dice.
  for (const f of seq.faults) {
    const occurs = roll() < f.chance;
    const u = roll();
    const real = roll() < f.realChance;
    const t1 = ms(f.window[0]);
    const t2 = ms(f.window[1]);
    s.faults[f.id] = {
      scheduledT: occurs ? t1 + Math.floor(u * (t2 - t1 + 1)) : null,
      real,
      active: false,
      resolved: false,
    };
  }
  s.rng = rng;
  return s;
}

// -------------------------------------------------------------------- apply

type Fail = string;

function listMissing(seq: Sequence, s: State, ids: string[]): string {
  return ids
    .filter((a) => !isComplete(seq, s, a))
    .map((a) => seq.steps.find((x) => x.id === a)?.label ?? seq.polls.find((x) => x.id === a)?.label ?? a)
    .join(", ");
}

function doStep(c: Ctx, role: Role, stepId: string): Fail | null {
  const { seq, s } = c;
  const step = seq.steps.find((x) => x.id === stepId);
  if (!step) return `unknown step "${stepId}"`;
  if (step.role !== role) {
    return `step "${step.label}" belongs to the ${ROLE_LABELS[step.role]} console, not ${ROLE_LABELS[role]}`;
  }
  if (s.phase !== "count" && s.phase !== "hold") return "the mission is not in progress";
  const st = s.steps[stepId]!;
  if (st.status === "done") return `step "${step.label}" is already done`;
  if (st.status === "locked") {
    if (!step.after.every((a) => isComplete(seq, s, a))) {
      return `step "${step.label}" is locked: waiting on ${listMissing(seq, s, step.after)}`;
    }
    if (!stepUnlocked(seq, s, step)) return `step "${step.label}" is not available: there is nothing to fix`;
    return `step "${step.label}" is not open yet (window opens at T${step.window ? step.window[0] : "?"} s)`;
  }
  if (st.status === "missed" && !stepUnlocked(seq, s, step)) {
    return `step "${step.label}" was missed and is still waiting on ${listMissing(seq, s, step.after)}`;
  }

  rebase(seq, s);
  for (const f of fixesFaults(seq, stepId)) {
    const fs = s.faults[f.id]!;
    if (fs.active && !fs.resolved) {
      fs.resolved = true;
      emit(c, "fault_resolved", f.role, { faultId: f.id });
    }
  }
  for (const e of step.effects ?? []) {
    if (e.driftPerSec !== undefined) s.drift[e.value] = e.driftPerSec;
    if (e.set !== undefined) s.anchors[e.value] = { v: e.set, e: s.elapsedMs };
  }
  syncValues(seq, s);
  st.status = "done";
  st.atT = s.tMs;
  emit(c, "step_done", role, { stepId, late: s.phase === "hold" });
  refresh(seq, s);
  return null;
}

function doPollOpen(c: Ctx, role: Role, pollId: string): Fail | null {
  const { seq, s } = c;
  const poll = seq.polls.find((x) => x.id === pollId);
  if (!poll) return `unknown poll "${pollId}"`;
  if (role !== "flight") return "only the Flight Director can open a poll";
  if (s.phase !== "count" && s.phase !== "hold") return "the mission is not in progress";
  const p = s.polls[pollId]!;
  if (p.status === "open") return `poll "${poll.label}" is already open`;
  const reopen = p.status === "closed" && !pollAllGo(seq, s, pollId);
  if (p.status === "closed" && !reopen) return `poll "${poll.label}" already closed with every seat go`;
  if (p.status === "locked") {
    if (!poll.after.every((a) => isComplete(seq, s, a))) {
      return `poll "${poll.label}" is locked: waiting on ${listMissing(seq, s, poll.after)}`;
    }
    return `poll "${poll.label}" is not open yet (window opens at T${poll.window[0]} s)`;
  }
  if (p.status === "missed" && !poll.after.every((a) => isComplete(seq, s, a))) {
    return `poll "${poll.label}" was missed and is still waiting on ${listMissing(seq, s, poll.after)}`;
  }
  if (Object.keys(p.reports).length > 0) p.history.push(p.reports);
  p.reports = {};
  p.status = "open";
  emit(c, "poll_opened", "flight", { pollId, round: p.history.length + 1 });
  return null;
}

function doPollReport(c: Ctx, role: Role, pollId: string, report: unknown): Fail | null {
  const { seq, s } = c;
  const poll = seq.polls.find((x) => x.id === pollId);
  if (!poll) return `unknown poll "${pollId}"`;
  if (role === "flight") return "the Flight Director runs the poll and does not report to it";
  if (report !== "go" && report !== "nogo") return 'report must be "go" or "nogo"';
  const p = s.polls[pollId]!;
  if (s.phase !== "count" && s.phase !== "hold") return "the mission is not in progress";
  if (p.status !== "open") return `poll "${poll.label}" is not open (it is ${p.status})`;
  if (p.reports[role]) return `${ROLE_LABELS[role]} has already reported on "${poll.label}"`;

  const showing = consoleShowsCaution(seq, s, role) ? "caution" : "nominal";
  p.reports[role] = { report, showing, atT: s.tMs };
  emit(c, "poll_report", role, { pollId, report, showing });
  if (report === "nogo" && s.phase === "count") {
    enterHold(c, `${ROLE_LABELS[role]} reported no-go on "${poll.label}"`);
  }
  if (reporters(seq).every((r) => p.reports[r])) {
    p.status = "closed";
    const allGo = reporters(seq).every((r) => p.reports[r]!.report === "go");
    emit(c, "poll_closed", "flight", { pollId, allGo });
  }
  refresh(seq, s);
  return null;
}

function doResume(c: Ctx): Fail | null {
  const { seq, s } = c;
  if (s.phase !== "hold") return "the mission is not on hold";
  const blockers: string[] = [];
  for (const step of seq.steps) {
    if (step.required && s.steps[step.id]!.status === "missed") blockers.push(`missed step: ${step.label}`);
  }
  for (const poll of seq.polls) {
    const st = s.polls[poll.id]!.status;
    if (st === "missed") blockers.push(`missed poll: ${poll.label}`);
    if (st === "open") blockers.push(`poll still open: ${poll.label}`);
  }
  if (blockers.length > 0) return `cannot resume: ${blockers.join("; ")}`;
  s.phase = "count";
  emit(c, "resume");
  settle(c);
  return null;
}

function applyAction(c: Ctx, action: Action, nowMs: number): Fail | null {
  const { seq, s } = c;
  if (!seq.roles.includes(action.role)) return `role "${String(action.role)}" is not part of this mission`;
  switch (action.type) {
    case "start":
      if (action.role !== "flight") return "only the Flight Director can start the countdown";
      if (s.phase !== "lobby") return "the countdown has already started";
      s.phase = "count";
      s.lastNowMs = nowMs;
      emit(c, "start", "flight");
      settle(c);
      return null;
    case "step":
      return doStep(c, action.role, action.stepId);
    case "poll_open":
      return doPollOpen(c, action.role, action.pollId);
    case "poll_report":
      return doPollReport(c, action.role, action.pollId, action.report);
    case "hold":
      if (action.role !== "flight") return "only the Flight Director can call a hold";
      if (s.phase !== "count") return s.phase === "hold" ? "the mission is already on hold" : "the mission is not counting";
      enterHold(c, "Flight Director called a hold");
      return null;
    case "resume":
      if (action.role !== "flight") return "only the Flight Director can resume the count";
      return doResume(c);
    case "scrub":
      if (action.role !== "flight") return "only the Flight Director can scrub";
      if (s.phase !== "count" && s.phase !== "hold") return "the mission is not in progress";
      emit(c, "scrub", "flight");
      finish(c, "scrub", ["Scrubbed by the Flight Director"]);
      return null;
    default:
      return `unknown action type "${String((action as { type?: unknown }).type)}"`;
  }
}

export function apply(seq: Sequence, state: State, action: Action, nowMs: number): ApplyResult {
  if (!Number.isFinite(nowMs)) return { ok: false, error: "nowMs must be a number", state, events: [] };
  nowMs = Math.round(nowMs);
  if (state.phase === "lobby" && action.type !== "start") {
    return { ok: false, error: "the countdown has not started", state, events: [] };
  }
  if (state.lastNowMs !== null && nowMs < state.lastNowMs) {
    return { ok: false, error: "time went backwards", state, events: [] };
  }
  const c: Ctx = { seq, s: structuredClone(state), ev: [] };
  runTo(c, nowMs);
  if (c.s.phase === "done") {
    return { ok: false, error: "the mission is over", state: c.s, events: c.ev };
  }
  const tickState = structuredClone(c.s);
  const tickEvents = [...c.ev];
  const error = applyAction(c, action, nowMs);
  if (error !== null) return { ok: false, error, state: tickState, events: tickEvents };
  syncValues(seq, c.s);
  return { ok: true, state: c.s, events: c.ev };
}
