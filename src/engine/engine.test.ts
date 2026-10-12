import { describe, expect, it } from "vitest";
import { nextRandom } from "./rng.ts";
import { apply, init, tick } from "./engine.ts";
import { parseSequence } from "./sequence.ts";
import { act, advance, advanceToT, begin, findSeed, loadMvp, runBot } from "./testutil.ts";
import type { Role, State } from "./types.ts";

const seq = loadMvp();

// seed recipes, found by scanning so the tests survive retuning of chances
const vent = (s: State) => s.faults.vent_stuck!;
const bus = (s: State) => s.faults.bus_sag!;
const REAL_VENT_ONLY = findSeed(seq, (s) => vent(s).scheduledT !== null && vent(s).real && bus(s).scheduledT === null);
const GLITCH_VENT_ONLY = findSeed(seq, (s) => vent(s).scheduledT !== null && !vent(s).real && bus(s).scheduledT === null);
const NO_FAULTS = findSeed(seq, (s) => vent(s).scheduledT === null && bus(s).scheduledT === null);
const BOTH_REAL = findSeed(
  seq,
  (s) => vent(s).scheduledT !== null && vent(s).real && bus(s).scheduledT !== null && bus(s).real,
);

const step = (role: Role, stepId: string) => ({ role, type: "step" as const, stepId });

describe("rng and init", () => {
  it("mulberry32 is deterministic and in [0,1)", () => {
    let a = 42;
    let b = 42;
    for (let i = 0; i < 100; i++) {
      const x = nextRandom(a);
      const y = nextRandom(b);
      a = x.state;
      b = y.state;
      expect(x.value).toBe(y.value);
      expect(x.value).toBeGreaterThanOrEqual(0);
      expect(x.value).toBeLessThan(1);
    }
  });

  it("init is a lobby, pre-rolls faults inside their windows, and is seed-determined", () => {
    const s = init(seq, 7);
    expect(s.phase).toBe("lobby");
    expect(s.tMs).toBe(-240_000);
    expect(init(seq, 7)).toEqual(s);
    for (const f of seq.faults) {
      const t = s.faults[f.id]!.scheduledT;
      if (t !== null) {
        expect(t).toBeGreaterThanOrEqual(f.window[0] * 1000);
        expect(t).toBeLessThanOrEqual(f.window[1] * 1000);
      }
    }
    const outcomes = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(init(seq, i).faults)));
    expect(outcomes.size).toBeGreaterThan(5);
  });

  it("state is plain JSON: a round trip changes nothing, and play continues identically", () => {
    const run = begin(seq, BOTH_REAL);
    runBot(run, { untilTMs: -100_000 });
    const copy: State = JSON.parse(JSON.stringify(run.state));
    expect(copy).toEqual(run.state);
    const a = tick(seq, run.state, run.now + 90_000);
    const b = tick(seq, copy, run.now + 90_000);
    expect(b).toEqual(a);
  });
});

describe("determinism, granularity, immutability", () => {
  it("same seed and same timed actions give an identical state and event log", () => {
    const a = runBot(begin(seq, BOTH_REAL), { fix: false });
    const b = runBot(begin(seq, BOTH_REAL), { fix: false });
    expect(b.state).toEqual(a.state);
    expect(b.events).toEqual(a.events);
    expect(a.state.phase).toBe("done");
  });

  it("different seeds can end differently", () => {
    const kinds = new Set(
      [REAL_VENT_ONLY, GLITCH_VENT_ONLY, NO_FAULTS].map((seed) => runBot(begin(seq, seed), { fix: false }).state.outcome!.kind),
    );
    expect(kinds).toEqual(new Set(["explosion", "success"]));
  });

  it("tick(tick(s,a),b) equals tick(s,b) across fault activations, misses, holds", () => {
    // the crew works until T-200 then goes idle: later steps get missed, a hold begins
    const run = runBot(begin(seq, BOTH_REAL), { fix: false, untilTMs: -200_000 });
    const s0 = run.state;
    const direct = tick(seq, s0, run.now + 300_000);
    expect(direct.state.holds).toBeGreaterThan(0);
    expect(Object.values(direct.state.faults).every((f) => f.active)).toBe(true);
    let seed = 99;
    const rnd = () => {
      const r = nextRandom(seed);
      seed = r.state;
      return r.value;
    };
    for (let trial = 0; trial < 20; trial++) {
      let s = s0;
      let t = run.now;
      const events: unknown[] = [];
      while (t < run.now + 300_000) {
        t = Math.min(run.now + 300_000, t + 1 + Math.floor(rnd() * 25_000));
        const r = tick(seq, s, t);
        s = r.state;
        events.push(...r.events);
        expect(s).toEqual(tick(seq, s0, t).state);
      }
      expect(s).toEqual(direct.state);
      expect(events).toEqual(direct.events);
    }
  });

  it("granularity independence holds through T-0 (explosion path) too", () => {
    const run = runBot(begin(seq, REAL_VENT_ONLY), { fix: false, untilTMs: -6000 });
    const direct = tick(seq, run.state, run.now + 150_000);
    expect(direct.state.outcome?.kind).toBe("explosion");
    for (const chunk of [333, 1000, 7777, 30_000]) {
      let s = run.state;
      const events: unknown[] = [];
      for (let t = run.now + chunk; ; t += chunk) {
        const r = tick(seq, s, Math.min(t, run.now + 150_000));
        s = r.state;
        events.push(...r.events);
        if (t >= run.now + 150_000) break;
      }
      expect(s).toEqual(direct.state);
      expect(events).toEqual(direct.events);
    }
  });

  it("never mutates its inputs", () => {
    const run = begin(seq, BOTH_REAL);
    const before = structuredClone(run.state);
    tick(seq, run.state, run.now + 50_000);
    expect(run.state).toEqual(before);
    apply(seq, run.state, step("ground", "arm_retract"), run.now + 1000);
    expect(run.state).toEqual(before);
    apply(seq, run.state, step("ground", "tank_pressurise"), run.now + 1000); // rejected
    expect(run.state).toEqual(before);
    const seqBefore = structuredClone(seq);
    runBot(run);
    expect(seq).toEqual(seqBefore);
    const s = init(seq, 3);
    const sBefore = structuredClone(s);
    apply(seq, s, { role: "flight", type: "start" }, 0);
    expect(s).toEqual(sBefore);
  });
});

describe("permissions and phases", () => {
  it("nothing but start works in the lobby, and only flight can start", () => {
    const s = init(seq, 1);
    const r = apply(seq, s, step("ground", "arm_retract"), 0);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("not started") });
    expect(apply(seq, s, { role: "ground", type: "start" }, 0)).toMatchObject({ ok: false });
    expect(apply(seq, s, { role: "flight", type: "start" }, 0).ok).toBe(true);
  });

  it("only flight can hold, resume, scrub, open polls", () => {
    const run = begin(seq, NO_FAULTS);
    for (const role of ["propulsion", "ground"] as Role[]) {
      for (const a of [{ type: "hold" }, { type: "resume" }, { type: "scrub" }, { type: "poll_open", pollId: "poll_1" }] as const) {
        const r = act(run, { role, ...a } as never);
        expect(r.ok, `${role} ${a.type}`).toBe(false);
      }
    }
    expect(run.state.phase).toBe("count");
    expect(act(run, { role: "flight", type: "hold" }).ok).toBe(true);
    expect(act(run, { role: "flight", type: "hold" })).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });

  it("a step can only be done by its own role", () => {
    const run = begin(seq, NO_FAULTS);
    advance(run, 1000);
    const r = act(run, step("propulsion", "arm_retract"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Ground Systems") });
    expect(act(run, step("ground", "arm_retract")).ok).toBe(true);
    expect(act(run, step("ground", "arm_retract"))).toMatchObject({ ok: false, error: expect.stringContaining("already done") });
    expect(act(run, step("ground", "nope"))).toMatchObject({ ok: false, error: expect.stringContaining("unknown step") });
  });

  it("flight does not report to polls; unknown roles and poll ids are refused", () => {
    const run = runBot(begin(seq, NO_FAULTS), { untilTMs: -111_000 });
    advanceToT(run, -109);
    expect(act(run, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "go" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("not open"),
    });
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    expect(act(run, { role: "flight", type: "poll_report", pollId: "poll_1", report: "go" }).ok).toBe(false);
    expect(act(run, { role: "ground", type: "poll_report", pollId: "nope", report: "go" }).ok).toBe(false);
    expect(act(run, { role: "weather" as Role, type: "hold" }).ok).toBe(false);
  });
});

describe("steps, windows, holds", () => {
  it("dependencies unlock steps on other consoles", () => {
    const run = begin(seq, NO_FAULTS);
    advanceToT(run, -229);
    expect(run.state.steps.tank_pressurise!.status).toBe("locked");
    const early = act(run, step("propulsion", "tank_pressurise"));
    expect(early).toMatchObject({ ok: false, error: expect.stringContaining("Retract crew access arm") });
    expect(act(run, step("ground", "arm_retract")).ok).toBe(true);
    expect(run.state.steps.tank_pressurise!.status).toBe("ready");
    expect(act(run, step("propulsion", "tank_pressurise")).ok).toBe(true);
    expect(run.state.values.tank_pressure).toBe(250);
  });

  it("a step is locked before its window opens", () => {
    const run = begin(seq, NO_FAULTS);
    act(run, step("ground", "arm_retract"));
    advanceToT(run, -235);
    expect(run.state.steps.tank_pressurise!.status).toBe("locked"); // opens at -230
    expect(act(run, step("propulsion", "tank_pressurise"))).toMatchObject({ ok: false, error: expect.stringContaining("not open yet") });
    advanceToT(run, -229);
    expect(run.state.steps.tank_pressurise!.status).toBe("ready");
  });

  it("an un-done required step is missed at its close and holds the mission", () => {
    const run = begin(seq, NO_FAULTS);
    advanceToT(run, -171);
    expect(run.state.phase).toBe("count");
    advanceToT(run, -169);
    expect(run.state.phase).toBe("hold");
    expect(run.state.holds).toBe(1);
    expect(run.state.steps.arm_retract!.status).toBe("missed");
    expect(run.state.tMs).toBe(-170_000); // clock frozen where the window closed
    expect(run.events.some((e) => e.kind === "step_missed" && e.data?.stepId === "arm_retract")).toBe(true);
    expect(run.events.find((e) => e.kind === "hold")!.data?.reason).toContain("Retract crew access arm");
    advance(run, 60_000);
    expect(run.state.tMs).toBe(-170_000);
  });

  it("a missed step can be done late; resume is refused until then", () => {
    const run = begin(seq, NO_FAULTS);
    advanceToT(run, -169);
    expect(act(run, { role: "flight", type: "resume" })).toMatchObject({ ok: false, error: expect.stringContaining("Retract crew access arm") });
    expect(act(run, step("ground", "arm_retract")).ok).toBe(true);
    expect(run.state.steps.arm_retract!.status).toBe("done");
    expect(run.events.find((e) => e.kind === "step_done")!.data?.late).toBe(true);
    // pad_clear also closes at -150 and is still pending: finish it too
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
    expect(run.state.phase).toBe("count");
    advance(run, 5_000);
    expect(run.state.tMs).toBe(-165_000);
  });

  it("values keep drifting during a hold while the clock is frozen", () => {
    const run = begin(seq, REAL_VENT_ONLY);
    runBot(run, { fix: false, untilTMs: vent(run.state).scheduledT! + 10_000 });
    expect(vent(run.state).active).toBe(true);
    expect(act(run, { role: "flight", type: "hold" }).ok).toBe(true);
    const v0 = run.state.values.tank_pressure!;
    const t0 = run.state.tMs;
    advance(run, 20_000);
    expect(run.state.tMs).toBe(t0);
    expect(run.state.values.tank_pressure! - v0).toBeCloseTo(0.9 * 20, 6);
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
    advance(run, 1000);
    expect(run.state.tMs).toBe(t0 + 1000);
  });

  it("scrub ends the mission with a scrub outcome and nothing more is accepted", () => {
    const run = begin(seq, NO_FAULTS);
    advance(run, 5000);
    expect(act(run, { role: "flight", type: "scrub" }).ok).toBe(true);
    expect(run.state.phase).toBe("done");
    expect(run.state.outcome).toMatchObject({ kind: "scrub" });
    expect(act(run, step("ground", "arm_retract"))).toMatchObject({ ok: false, error: expect.stringContaining("over") });
  });
});

describe("faults", () => {
  it("fault_active events carry the truth for the log, and only real faults bend the drift", () => {
    const real = runBot(begin(seq, REAL_VENT_ONLY), { fix: false, untilTMs: -100_000 });
    const glitch = runBot(begin(seq, GLITCH_VENT_ONLY), { fix: false, untilTMs: -100_000 });
    expect(real.events.find((e) => e.kind === "fault_active")).toMatchObject({ role: "propulsion", data: { real: true } });
    expect(glitch.events.find((e) => e.kind === "fault_active")).toMatchObject({ role: "propulsion", data: { real: false } });
    expect(real.state.values.tank_pressure).toBeGreaterThan(250);
    expect(glitch.state.values.tank_pressure).toBe(250);
  });

  it("the fix step is locked until the fault is active, then resolves it and reverts the drift", () => {
    const run = begin(seq, REAL_VENT_ONLY);
    runBot(run, { fix: false, untilTMs: -200_000 });
    expect(act(run, step("propulsion", "fix_vent"))).toMatchObject({ ok: false });
    runBot(run, { fix: false, untilTMs: vent(run.state).scheduledT! + 30_000 });
    expect(vent(run.state).active).toBe(true);
    expect(run.state.values.tank_pressure).toBeGreaterThan(250 + 0.9 * 29);
    expect(act(run, step("propulsion", "fix_vent")).ok).toBe(true);
    expect(run.state.faults.vent_stuck!.resolved).toBe(true);
    expect(run.state.values.tank_pressure).toBe(250);
    advance(run, 60_000);
    expect(run.state.values.tank_pressure).toBe(250);
    expect(run.events.some((e) => e.kind === "fault_resolved")).toBe(true);
  });
});

describe("polls", () => {
  function toPoll1(seed: number) {
    const run = runBot(begin(seq, seed), { fix: false, untilTMs: -111_000 });
    advanceToT(run, -109);
    // everything poll_1 waits on is done by now; it opens at -110
    expect(run.state.polls.poll_1!.status).toBe("ready");
    return run;
  }

  it("records what each seat showed beside what it reported (go while a console shows caution)", () => {
    const run = toPoll1(REAL_VENT_ONLY);
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    expect(act(run, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "go" }).ok).toBe(true);
    expect(act(run, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "nogo" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already reported"),
    });
    expect(run.state.polls.poll_1!.status).toBe("open");
    expect(act(run, { role: "ground", type: "poll_report", pollId: "poll_1", report: "go" }).ok).toBe(true);
    const p = run.state.polls.poll_1!;
    expect(p.status).toBe("closed");
    expect(p.reports.propulsion).toMatchObject({ report: "go", showing: "caution" });
    expect(p.reports.ground).toMatchObject({ report: "go", showing: "nominal" });
    expect(run.state.phase).toBe("count");
  });

  it("a console that has fixed its fault shows nominal", () => {
    const run = runBot(begin(seq, REAL_VENT_ONLY), { untilTMs: -111_000 });
    advanceToT(run, -109);
    act(run, { role: "flight", type: "poll_open", pollId: "poll_1" });
    act(run, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "go" });
    expect(run.state.polls.poll_1!.reports.propulsion!.showing).toBe("nominal");
  });

  it("a glitch left alone reports go while showing caution, and the mission still succeeds", () => {
    const run = runBot(begin(seq, GLITCH_VENT_ONLY), { fix: false });
    expect(run.state.outcome!.kind).toBe("success");
    expect(run.state.polls.poll_1!.reports.propulsion).toMatchObject({ report: "go", showing: "caution" });
  });

  it("a nogo holds the mission; the poll stays open until all report; resume then re-poll", () => {
    const run = toPoll1(NO_FAULTS);
    act(run, { role: "flight", type: "poll_open", pollId: "poll_1" });
    expect(act(run, { role: "ground", type: "poll_report", pollId: "poll_1", report: "nogo" }).ok).toBe(true);
    expect(run.state.phase).toBe("hold");
    expect(run.state.holds).toBe(1);
    expect(act(run, { role: "flight", type: "resume" })).toMatchObject({ ok: false, error: expect.stringContaining("poll still open") });
    act(run, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "go" });
    expect(run.state.polls.poll_1!.status).toBe("closed");
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
    // the no-go round blocks the dependants until flight re-polls
    expect(run.state.steps.igniter_arm!.status).toBe("locked");
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    expect(run.state.polls.poll_1!.history).toHaveLength(1);
    expect(run.state.polls.poll_1!.history[0]!.ground!.report).toBe("nogo");
    expect(run.state.polls.poll_1!.reports).toEqual({});
    runBot(run);
    expect(run.state.outcome!.kind).toBe("success");
  });

  it("a poll left un-closed past its window holds the mission", () => {
    const run = toPoll1(NO_FAULTS);
    advanceToT(run, -59);
    expect(run.state.phase).toBe("hold");
    expect(run.state.polls.poll_1!.status).toBe("missed");
    expect(run.events.some((e) => e.kind === "poll_missed")).toBe(true);
    // late: flight opens it during the hold, seats answer, resume
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    act(run, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "go" });
    act(run, { role: "ground", type: "poll_report", pollId: "poll_1", report: "go" });
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
  });
});

describe("T-0", () => {
  it("a prompt crew wins on every seed (all fault combinations), fixing what the consoles show", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const run = runBot(begin(seq, seed));
      expect(run.state.outcome?.kind, `seed ${seed}`).toBe("success");
      expect(run.state.holds, `seed ${seed}`).toBe(0);
      expect(run.state.tMs).toBe(0);
      for (const f of Object.values(run.state.faults)) if (f.active) kinds.add(String(f.real));
    }
    expect(kinds).toEqual(new Set(["true", "false"]));
  });

  it("a scripted winning playthrough by hand, event by event", () => {
    const run = begin(seq, NO_FAULTS);
    const go = (tSec: number) => advanceToT(run, tSec);
    go(-239);
    expect(act(run, step("ground", "arm_retract")).ok).toBe(true);
    expect(act(run, step("ground", "pad_clear")).ok).toBe(true);
    go(-199);
    expect(act(run, step("propulsion", "tank_pressurise")).ok).toBe(true);
    expect(act(run, step("propulsion", "feed_prime")).ok).toBe(true);
    expect(act(run, step("ground", "deluge_arm")).ok).toBe(true);
    expect(act(run, step("ground", "bus_transfer")).ok).toBe(true);
    go(-149);
    expect(act(run, step("propulsion", "engine_chill")).ok).toBe(true);
    go(-109);
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    for (const role of ["propulsion", "ground"] as Role[]) {
      expect(act(run, { role, type: "poll_report", pollId: "poll_1", report: "go" }).ok).toBe(true);
    }
    go(-85);
    expect(act(run, step("propulsion", "igniter_arm")).ok).toBe(true);
    expect(act(run, step("ground", "range_confirm")).ok).toBe(true);
    go(-35);
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_2" }).ok).toBe(true);
    for (const role of ["propulsion", "ground"] as Role[]) {
      expect(act(run, { role, type: "poll_report", pollId: "poll_2", report: "go" }).ok).toBe(true);
    }
    go(-20);
    expect(act(run, step("flight", "launch_authority")).ok).toBe(true);
    advance(run, 30_000);
    expect(run.state.phase).toBe("done");
    expect(run.state.outcome).toMatchObject({ kind: "success", atT: 0 });
    expect(run.state.holds).toBe(0);
    expect(run.events.at(-1)!.kind).toBe("outcome");
  });

  it("ignoring a real fault ends in an explosion with readable reasons", () => {
    const run = runBot(begin(seq, REAL_VENT_ONLY), { fix: false });
    expect(run.state.outcome!.kind).toBe("explosion");
    const reasons = run.state.outcome!.reasons.join(" | ");
    expect(reasons).toContain("Tank vent valve position unconfirmed");
    expect(reasons).toContain("Propellant tank pressure");
    expect(run.state.polls.poll_1!.reports.propulsion).toMatchObject({ report: "go", showing: "caution" });
  });

  it("an unresolved real fault explodes even if every value is inside its limit", () => {
    const s0 = init(seq, REAL_VENT_ONLY);
    const quiet = parseSequence({ ...structuredClone(seq), faults: seq.faults.map((f) => ({ ...f, effect: undefined })) });
    const run = runBot(begin(quiet, REAL_VENT_ONLY), { fix: false });
    expect(s0.faults.vent_stuck!.real).toBe(true);
    expect(run.state.outcome!.kind).toBe("explosion");
    expect(run.state.outcome!.reasons.join(" ")).toContain("real fault");
  });

  it("unmet requirements at T-0 hold the mission at T-1 s instead of launching", () => {
    const raw = structuredClone(seq) as any;
    raw.steps.push({ id: "late_check", role: "ground", label: "Final safing check", after: [], required: true });
    const s2 = parseSequence(raw);
    const run = runBot(begin(s2, NO_FAULTS), { untilTMs: -2000, skip: ["late_check"] });
    advance(run, 5000); // through T-0
    expect(run.state.phase).toBe("hold");
    expect(run.state.tMs).toBe(-1000);
    expect(run.state.holds).toBe(1);
    expect(run.events.at(-1)!.data?.reason).toContain("Final safing check");
    // resuming without fixing re-evaluates one second later and holds again
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
    advance(run, 2000);
    expect(run.state.phase).toBe("hold");
    expect(run.state.holds).toBe(2);
    // doing it late and resuming launches
    expect(act(run, step("ground", "late_check")).ok).toBe(true);
    expect(act(run, { role: "flight", type: "resume" }).ok).toBe(true);
    advance(run, 2000);
    expect(run.state.outcome!.kind).toBe("success");
  });
});
