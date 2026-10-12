import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextRandom } from "./rng.ts";
import { apply, init, tick } from "./engine.ts";
import { parseSequence, SequenceError } from "./sequence.ts";
import { act, advance, advanceToT, begin, loadKestrel2, loadKestrel3, loadMvp, runBot, view, weatherAmber } from "./testutil.ts";
import type { Run } from "./testutil.ts";
import { GLITCH_OUT_SEC, ROLE_LABELS, ROLES } from "./types.ts";
import type { Sequence, State } from "./types.ts";

const mvp = loadMvp();
const k2 = loadKestrel2();
const k3 = loadKestrel3();
const rawK3 = (): any => JSON.parse(readFileSync(new URL("../../data/sequences/kestrel3.json", import.meta.url), "utf8"));
const A = "track_deviation";
const ANOMALY_LABEL = "Radar track deviating from the planned trajectory";
const CROSS_LABEL = "Inertial vs radar track agreement";
const RANGE_IDS = ["impact_offset", "hazard_area"];

/** kestrel3 with calm weather and no pad faults: a prompt crew always reaches liftoff. */
function calm(edit?: (r: any) => void): Sequence {
  const r = rawK3();
  for (const id of ["ceiling", "shear", "lightning"]) r.values[id].fronts.driftPerSec = [0, 0];
  r.values.ceiling.start = 5000;
  r.values.lightning.start = 40;
  for (const f of r.faults) f.chance = 0;
  edit?.(r);
  return parseSequence(r);
}
const calm3 = calm();

const anomalyOf = (s: State) => s.anomalies[A]!;
function seedWhere(seq: Sequence, pred: (a: State["anomalies"][string]) => boolean): number {
  for (let seed = 1; seed < 500; seed++) if (pred(init(seq, seed).anomalies[A]!)) return seed;
  throw new Error("no seed");
}
const realSeed = seedWhere(calm3, (a) => a.scheduledT !== null && a.real);
const glitchSeed = seedWhere(calm3, (a) => a.scheduledT !== null && !a.real);
const quietSeed = seedWhere(calm3, (a) => a.scheduledT === null);

/** Fly the prompt crew to liftoff: the run sits at T+0 in ascent. */
function toLiftoff(seq: Sequence, seed: number): Run {
  const run = begin(seq, seed);
  runBot(run, { untilTMs: 0 });
  expect(run.state.phase).toBe("ascent");
  expect(run.state.tMs).toBe(0);
  return run;
}
/** Move the run's clock to T+sec (whole seconds). */
function toPlus(run: Run, sec: number): void {
  advance(run, sec * 1000 - run.state.tMs);
}

describe("the range role", () => {
  it("is a role with a label, and only kestrel3 seats it", () => {
    expect(ROLES).toContain("range");
    expect(ROLE_LABELS.range).toBe("Range Safety");
    expect(k3.roles).toEqual(["flight", "propulsion", "ground", "weather", "range"]);
    expect(k2.roles).not.toContain("range");
    expect(mvp.roles).not.toContain("range");
  });

  it("the range console holds the range values and steps; no other console sees them", () => {
    const run = begin(k3, 3);
    advance(run, 5000);
    const r = view(k3, run.state, "range");
    expect(r.values.map((v) => v.id).sort()).toEqual([...RANGE_IDS].sort());
    expect(r.steps.map((s) => s.id).sort()).toEqual(["fts_arm", "hazard_clear"]);
    for (const role of ["flight", "propulsion", "ground", "weather"] as const) {
      const text = JSON.stringify(view(k3, run.state, role));
      for (const id of RANGE_IDS) expect(text, `${role} sees ${id}`).not.toContain(`"${id}"`);
      expect(text).not.toContain("Impact point offset");
      expect(text).not.toContain("Vessels inside the hazard area");
    }
  });

  it("range reports in both polls, and its steps gate them", () => {
    const run = begin(k3, 3);
    expect(k3.polls.map((p) => p.after.includes("hazard_clear") || p.after.includes("fts_arm"))).toEqual([true, true]);
    const flight = () => view(k3, run.state, "flight").polls;
    runBot(run, { untilTMs: -130_000 });
    advanceToT(run, -124);
    expect(act(run, { role: "flight", type: "poll_open", pollId: "poll_1" }).ok).toBe(true);
    expect(flight()[0]!.pending).toContain("range");
  });
});

describe("ascent", () => {
  it("a good T-0 ends the mission only in a sequence without ascentSec", () => {
    const noAscent = calm((r) => {
      delete r.ascentSec;
      delete r.anomalies;
    });
    const a = begin(noAscent, 1);
    runBot(a);
    expect(a.state.phase).toBe("done");
    expect(a.state.outcome).toMatchObject({ kind: "success", atT: 0 });

    const b = toLiftoff(calm3, quietSeed);
    expect(b.state.outcome).toBeNull();
    expect(b.events.some((e) => e.kind === "liftoff")).toBe(true);
    toPlus(b, 30);
    expect(b.state.phase).toBe("ascent");
    expect(b.state.tMs).toBe(30_000);
    expect(view(calm3, b.state, "flight").tMs).toBe(30_000);
    toPlus(b, 60);
    expect(b.state.phase).toBe("done");
    expect(b.state.outcome).toMatchObject({ kind: "success", atT: 60_000 });
    expect(b.state.outcome!.reasons[0]).toContain("T+60");
  });

  it("the existing sequences still end at T-0", () => {
    for (const seq of [mvp, k2]) {
      const run = begin(seq, 2);
      runBot(run);
      expect(run.state.outcome!.kind === "success" ? run.state.outcome!.atT : 0).toBe(0);
      expect(run.state.phase).toBe("done");
      expect(run.events.some((e) => e.kind === "liftoff")).toBe(false);
    }
  });

  it("hold, resume, scrub, steps and polls are refused in ascent, and the vehicle flies on", () => {
    const run = toLiftoff(calm3, quietSeed);
    toPlus(run, 10);
    const before = structuredClone(run.state);
    const refused = (a: Parameters<typeof act>[1]) => {
      const r = act(run, a);
      expect(r.ok).toBe(false);
      return (r as { error: string }).error;
    };
    expect(refused({ role: "flight", type: "hold" })).toMatch(/launched.*holds are impossible/);
    expect(refused({ role: "flight", type: "resume" })).toMatch(/launched/);
    expect(refused({ role: "flight", type: "scrub" })).toMatch(/launched.*Range Safety can terminate/);
    expect(refused({ role: "ground", type: "step", stepId: "arm_retract" })).toMatch(/launched/);
    expect(refused({ role: "flight", type: "poll_open", pollId: "poll_1" })).toMatch(/launched/);
    expect(refused({ role: "ground", type: "poll_report", pollId: "poll_1", report: "go" })).toMatch(/launched/);
    expect(run.state).toEqual(before);
    expect(run.state.holds).toBe(0);
    toPlus(run, 20);
    expect(run.state.phase).toBe("ascent");
  });

  it("a holdWhen bot cannot hold in ascent either", () => {
    const run = begin(calm3, quietSeed);
    runBot(run, { holdWhen: (r) => r.state.phase === "ascent" });
    expect(run.state.holds).toBe(0);
    expect(run.state.outcome!.kind).toBe("success");
  });

  it("an old snapshot with no anomalies key still ticks in a sequence without anomalies", () => {
    const run = begin(k2, 9);
    const old: any = JSON.parse(JSON.stringify(run.state));
    delete old.anomalies;
    expect(tick(k2, old, run.now + 30_000).state.tMs).toBe(run.state.tMs + 30_000);
  });
});

describe("anomaly pre-roll", () => {
  it("is seed-determined plain JSON inside its window, three draws per anomaly after everything else", () => {
    const a = init(k3, 11);
    expect(init(k3, 11)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    let hits = 0;
    let reals = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = init(k3, seed).anomalies[A]!;
      expect(s).toMatchObject({ active: false, stage: "pending", activeAt: null });
      if (s.scheduledT !== null) {
        hits++;
        if (s.real) reals++;
        expect(s.scheduledT).toBeGreaterThanOrEqual(5000);
        expect(s.scheduledT).toBeLessThanOrEqual(40_000);
      }
    }
    expect(hits / 300).toBeGreaterThan(0.5);
    expect(hits / 300).toBeLessThan(0.7);
    expect(reals / hits).toBeGreaterThan(0.4);
    expect(reals / hits).toBeLessThan(0.6);
  });

  it("does not move any other sequence's dice", () => {
    // faults and the number of fronts are what kestrel2 rolled; kestrel3 adds three draws at the end
    const k = init(k3, 7);
    const o = init(k2, 7);
    expect(k.faults).toEqual(o.faults);
    // same front schedule length (the rate ranges are kestrel3's own, slightly kinder)
    expect(Object.values(k.fronts).map((f) => f.length)).toEqual(Object.values(o.fronts).map((f) => f.length));
    const draws = (seed: number, n: number): number => {
      let st = seed | 0;
      for (let i = 0; i < n; i++) st = nextRandom(st).state;
      return st;
    };
    const frontDraws = (s: State) => Object.values(s.fronts).reduce((n, f) => n + f.length, 0);
    // mvp: 2 faults x 3 draws; kestrel2: plus one per front; kestrel3: plus 3 for its anomaly
    expect(init(mvp, 7).rng).toBe(draws(7, 6));
    expect(o.rng).toBe(draws(7, 6 + frontDraws(o)));
    expect(k.rng).toBe(draws(7, 6 + frontDraws(k) + 3));
    expect(init(mvp, 7).anomalies).toEqual({});
    expect(o.anomalies).toEqual({});
    // dropping the anomaly from kestrel3 gives back exactly the earlier rolls
    const bare = parseSequence((() => { const r = rawK3(); delete r.anomalies; delete r.ascentSec; return r; })());
    const b = init(bare, 7);
    expect(b.faults).toEqual(k.faults);
    expect(b.fronts).toEqual(k.fronts);
    expect(b.rng).toBe(draws(7, 6 + frontDraws(b)));
  });
});

describe("a real anomaly", () => {
  const exact = () => toLiftoff(calm3, realSeed);

  it("activates at its scheduled instant, shows a caution on range and abnormal on propulsion", () => {
    const run = exact();
    const t = anomalyOf(run.state).scheduledT!;
    advance(run, t - 1 - run.state.tMs);
    expect(anomalyOf(run.state).active).toBe(false);
    expect(view(calm3, run.state, "range").cautions).toEqual([]);
    advance(run, 1);
    expect(anomalyOf(run.state)).toMatchObject({ active: true, stage: "out", activeAt: t });
    expect(view(calm3, run.state, "range").cautions).toEqual([ANOMALY_LABEL]);
    expect(view(calm3, run.state, "propulsion").crossChecks.map((c) => [c.label, c.reading])).toContainEqual([CROSS_LABEL, "abnormal"]);
    expect(run.events.find((e) => e.kind === "anomaly_active")).toMatchObject({ atT: t, role: "range", data: { anomalyId: A, real: true } });
  });

  it("the value drifts to its limit; unterminated, the mission ends in a range violation at the exact crossing", () => {
    const run = exact();
    const t = anomalyOf(run.state).scheduledT!;
    toPlus(run, 60 - 1);
    // not yet: the violation comes at activation + 16 s, earlier than the end of the ascent
    expect(run.state.phase).toBe("done");
    expect(run.state.outcome).toMatchObject({ kind: "range_violation", atT: t + 16_000 });
    expect(run.state.outcome!.reasons[0]).toBe("Vehicle left the safety corridor before termination");
    expect(run.state.values.impact_offset).toBe(8);
    expect(run.events.at(-1)!.kind).toBe("outcome");
  });

  it("one tick equals many chunked ticks, to the bit, including the split at the crossing", () => {
    const s0 = exact().state;
    const t1 = s0.lastNowMs! + 60_000;
    const direct = tick(calm3, s0, t1);
    expect(direct.state.outcome!.kind).toBe("range_violation");
    for (const chunk of [1, 7, 333, 1000, 4999, 16_000, 16_001, 59_999]) {
      let s = s0;
      const events: unknown[] = [];
      for (let t = s0.lastNowMs! + chunk; ; t += chunk) {
        const r = tick(calm3, s, Math.min(t, t1));
        s = r.state;
        events.push(...r.events);
        if (t >= t1) break;
      }
      expect(s, `chunk ${chunk}`).toEqual(direct.state);
      expect(events, `chunk ${chunk}`).toEqual(direct.events);
    }
  }, 30_000);

  it("the crossing is found in whole milliseconds for an awkward rate, and not a millisecond early", () => {
    const odd = calm((r) => { r.anomalies[0].driftPerSec = 0.37; });
    const seed = seedWhere(odd, (a) => a.scheduledT !== null && a.real);
    const run = toLiftoff(odd, seed);
    const t = anomalyOf(run.state).scheduledT!;
    const lift = structuredClone(run.state);
    const crossing = t + Math.ceil(8000 / 0.37);
    toPlus(run, 60);
    expect(run.state.outcome).toMatchObject({ kind: "range_violation", atT: crossing });
    expect(run.state.values.impact_offset!).toBeGreaterThanOrEqual(8);
    const before = tick(odd, lift, lift.lastNowMs! + crossing - 1);
    expect(before.state.phase).toBe("ascent");
    expect(before.state.values.impact_offset!).toBeLessThan(8);
    // chunked equals one tick for this rate too
    let s = lift;
    for (let t2 = lift.lastNowMs! + 777; ; t2 += 777) {
      s = tick(odd, s, Math.min(t2, lift.lastNowMs! + 60_000)).state;
      if (t2 >= lift.lastNowMs! + 60_000) break;
    }
    expect(s).toEqual(run.state);
  });

  it("a negative rate heads for the low limit", () => {
    const neg = calm((r) => { r.anomalies[0].driftPerSec = -0.5; });
    const seed = seedWhere(neg, (a) => a.scheduledT !== null && a.real);
    const run = toLiftoff(neg, seed);
    const t = anomalyOf(run.state).scheduledT!;
    toPlus(run, 60);
    expect(run.state.outcome).toMatchObject({ kind: "range_violation", atT: t + 16_000 });
    expect(run.state.values.impact_offset).toBe(-8);
  });

  it("terminated in time: the outcome is terminated, reasons call it a correct call", () => {
    const run = exact();
    const t = anomalyOf(run.state).scheduledT!;
    advance(run, t + 3000 - run.state.tMs);
    expect(view(calm3, run.state, "range").terminateAvailable).toBe(true);
    const r = act(run, { role: "range", type: "terminate" });
    expect(r.ok).toBe(true);
    expect(run.state.phase).toBe("done");
    expect(run.state.outcome!.kind).toBe("terminated");
    expect(run.state.outcome!.atT).toBe(t + 3000);
    expect(run.state.outcome!.reasons[0]).toContain("correct call");
    expect(run.state.outcome!.reasons[0]).not.toContain("healthy vehicle");
    expect(run.events.slice(-2).map((e) => e.kind)).toEqual(["terminate", "outcome"]);
    expect(run.events.find((e) => e.kind === "terminate")).toMatchObject({ role: "range", data: { real: true } });
  });

  it("terminating at the crossing instant is too late; one millisecond earlier is not", () => {
    const late = exact();
    const t = anomalyOf(late.state).scheduledT!;
    advance(late, t + 16_000 - late.state.tMs);
    expect(late.state.outcome!.kind).toBe("range_violation");
    expect(act(late, { role: "range", type: "terminate" })).toMatchObject({ ok: false, error: "the mission is over" });

    const ok = exact();
    advance(ok, t + 15_999 - ok.state.tMs);
    expect(act(ok, { role: "range", type: "terminate" }).ok).toBe(true);
    expect(ok.state.outcome!.kind).toBe("terminated");
  });

  it("a late acting terminate that arrives after the crossing is refused with the violation recorded", () => {
    const run = exact();
    const t = anomalyOf(run.state).scheduledT!;
    run.now += t + 20_000 - run.state.tMs; // the action's clock is already past the crossing
    const r = apply(calm3, run.state, { role: "range", type: "terminate" }, run.now);
    expect(r.ok).toBe(false);
    expect(r.state.outcome).toMatchObject({ kind: "range_violation", atT: t + 16_000 });
    expect(r.events.map((e) => e.kind)).toEqual(["anomaly_active", "outcome"]);
  });
});

describe("a glitch", () => {
  const flown = () => toLiftoff(calm3, glitchSeed);

  it("excursion: out for 8 s at the rate, back for 8 s, then flat, and never near the limit", () => {
    const run = flown();
    const t = anomalyOf(run.state).scheduledT!;
    const at = (secAfter: number): number => {
      advance(run, t + secAfter * 1000 - run.state.tMs);
      return run.state.values.impact_offset!;
    };
    expect(GLITCH_OUT_SEC).toBe(8);
    expect(at(0)).toBe(0);
    expect(at(4)).toBe(2);
    expect(at(8)).toBe(4);
    expect(at(12)).toBe(2);
    expect(at(16)).toBe(0);
    expect(anomalyOf(run.state).stage).toBe("over");
    expect(at(20)).toBe(0);
    expect(run.state.phase).toBe("ascent");
  });

  it("looks the same on the range console as a real anomaly while it runs, but propulsion reads normal", () => {
    const run = flown();
    const t = anomalyOf(run.state).scheduledT!;
    advance(run, t + 2000 - run.state.tMs);
    expect(view(calm3, run.state, "range").cautions).toEqual([ANOMALY_LABEL]);
    expect(view(calm3, run.state, "propulsion").crossChecks.map((c) => [c.label, c.reading])).toContainEqual([CROSS_LABEL, "normal"]);
    const real = toLiftoff(calm3, realSeed);
    advance(real, anomalyOf(real.state).scheduledT! + 2000 - real.state.tMs);
    expect(view(calm3, real.state, "range").values.find((v) => v.id === "impact_offset")!.value).toBe(
      view(calm3, run.state, "range").values.find((v) => v.id === "impact_offset")!.value,
    );
  });

  it("ignored, the mission is a success at T+60", () => {
    const run = flown();
    toPlus(run, 60);
    expect(run.state.outcome).toMatchObject({ kind: "success", atT: 60_000 });
    expect(run.state.outcome!.reasons[0]).toContain("glitch");
  });

  it("one tick equals many chunked ticks across the excursion's turning points", () => {
    const s0 = flown().state;
    const t1 = s0.lastNowMs! + 60_000;
    const direct = tick(calm3, s0, t1);
    for (const chunk of [1, 333, 1000, 7999, 8000, 8001]) {
      let s = s0;
      const events: unknown[] = [];
      for (let t = s0.lastNowMs! + chunk; ; t += chunk) {
        const r = tick(calm3, s, Math.min(t, t1));
        s = r.state;
        events.push(...r.events);
        if (t >= t1) break;
      }
      expect(s, `chunk ${chunk}`).toEqual(direct.state);
      expect(events, `chunk ${chunk}`).toEqual(direct.events);
    }
  }, 30_000);

  it("terminated: the outcome is terminated, and the reason says a healthy vehicle was destroyed", () => {
    const run = flown();
    const t = anomalyOf(run.state).scheduledT!;
    advance(run, t + 5000 - run.state.tMs);
    expect(act(run, { role: "range", type: "terminate" }).ok).toBe(true);
    expect(run.state.outcome!.kind).toBe("terminated");
    expect(run.state.outcome!.reasons[0]).toContain("healthy vehicle");
    expect(run.state.outcome!.reasons[0]).not.toContain("correct call");
    expect(run.events.find((e) => e.kind === "terminate")!.data).toMatchObject({ real: false });
  });
});

describe("terminate", () => {
  it("with no anomaly it destroys a healthy vehicle", () => {
    const run = toLiftoff(calm3, quietSeed);
    toPlus(run, 20);
    expect(act(run, { role: "range", type: "terminate" }).ok).toBe(true);
    expect(run.state.outcome!.kind).toBe("terminated");
    expect(run.state.outcome!.reasons[0]).toContain("healthy vehicle");
    expect(run.state.outcome!.reasons[0]).toContain("no anomaly");
  });

  it("an anomaly that has not appeared yet does not make it a correct call", () => {
    const run = toLiftoff(calm3, realSeed);
    expect(anomalyOf(run.state).scheduledT!).toBeGreaterThan(0);
    advance(run, 1000);
    expect(act(run, { role: "range", type: "terminate" }).ok).toBe(true);
    expect(run.state.outcome!.reasons[0]).toContain("healthy vehicle");
  });

  it("is refused before ascent, in the lobby, and for every seat but range", () => {
    const run = begin(calm3, quietSeed);
    advance(run, 20_000);
    expect(act(run, { role: "range", type: "terminate" })).toMatchObject({ ok: false, error: expect.stringMatching(/has not launched/) });
    for (const r of ["flight", "propulsion", "ground", "weather"] as const) {
      expect(act(run, { role: r, type: "terminate" })).toMatchObject({ ok: false, error: expect.stringMatching(/only Range Safety/) });
    }
    expect(run.state.phase).toBe("count");
    const lobby = init(calm3, 1);
    expect(apply(calm3, lobby, { role: "range", type: "terminate" }, 0)).toMatchObject({ ok: false });
    const asc = toLiftoff(calm3, quietSeed);
    for (const r of ["flight", "propulsion", "ground", "weather"] as const) {
      expect(act(asc, { role: r, type: "terminate" })).toMatchObject({ ok: false, error: expect.stringMatching(/only Range Safety/) });
    }
    expect(asc.state.phase).toBe("ascent");
  });

  it("is refused on a hold, and in the old sequences", () => {
    const run = begin(calm3, quietSeed);
    advance(run, 5000);
    act(run, { role: "flight", type: "hold" });
    expect(act(run, { role: "range", type: "terminate" }).ok).toBe(false);
    const m = begin(mvp, 1);
    advance(m, 5000);
    expect(act(m, { role: "range", type: "terminate" })).toMatchObject({ ok: false, error: expect.stringMatching(/not part of this mission/) });
  });

  it("is refused after the mission is over", () => {
    const run = toLiftoff(calm3, quietSeed);
    toPlus(run, 60);
    expect(act(run, { role: "range", type: "terminate" })).toMatchObject({ ok: false, error: "the mission is over" });
  });
});

describe("redaction", () => {
  it("terminate is offered to range in ascent and to nobody else, ever", () => {
    const run = begin(calm3, glitchSeed);
    const seen: string[] = [];
    const sweep = (label: string) => {
      for (const role of calm3.roles) {
        const v = view(calm3, run.state, role);
        if (v.terminateAvailable) seen.push(`${label}:${role}`);
        if (role !== "range") expect(JSON.stringify(v)).not.toContain("terminateAvailable");
      }
    };
    sweep("lobbyless");
    runBot(run, { untilTMs: 0, onAscent: () => {} });
    sweep("liftoff");
    toPlus(run, 20);
    sweep("ascent");
    toPlus(run, 60);
    sweep("done");
    expect(seen).toEqual(["liftoff:range", "ascent:range"]);
    expect(view(calm3, init(calm3, 1), "range").terminateAvailable).toBeUndefined();
  });

  it("range data and the anomaly never reach another console before the end", () => {
    for (const seed of [realSeed, glitchSeed]) {
      const run = toLiftoff(calm3, seed);
      advance(run, anomalyOf(run.state).scheduledT! + 3000 - run.state.tMs);
      expect(run.state.phase).toBe("ascent");
      for (const role of ["flight", "propulsion", "ground", "weather"] as const) {
        const v = view(calm3, run.state, role);
        const text = JSON.stringify(v);
        for (const needle of ["impact_offset", "hazard_area", "Impact point", ANOMALY_LABEL, "track_deviation"]) {
          expect(text, `${role} sees ${needle}`).not.toContain(needle);
        }
        expect(v.cautions).toEqual([]);
        expect(v).not.toHaveProperty("debrief");
        // the cross-check lives on propulsion alone, and it never says real or glitch
        if (role === "propulsion") expect(v.crossChecks.map((c) => c.label)).toContain(CROSS_LABEL);
        else expect(text).not.toContain(CROSS_LABEL);
      }
      const rangeText = JSON.stringify(view(calm3, run.state, "range"));
      expect(rangeText).not.toContain('"real"');
      expect(rangeText).not.toContain("scheduledT");
      expect(rangeText).not.toContain("stage");
    }
  });

  it("flight's checklist is the same with or without an anomaly", () => {
    const real = toLiftoff(calm3, realSeed);
    const before = JSON.stringify(view(calm3, real.state, "flight").checklist);
    advance(real, anomalyOf(real.state).scheduledT! + 3000 - real.state.tMs);
    expect(real.state.phase).toBe("ascent");
    expect(JSON.stringify(view(calm3, real.state, "flight").checklist)).toBe(before);
    const quiet = toLiftoff(calm3, quietSeed);
    expect(JSON.stringify(view(calm3, quiet.state, "flight").checklist)).toBe(before);
  });
});

describe("debrief", () => {
  it("lists the anomaly: real or glitch, when it appeared, when it was terminated", () => {
    const real = toLiftoff(calm3, realSeed);
    const t = anomalyOf(real.state).scheduledT!;
    advance(real, t + 2000 - real.state.tMs);
    act(real, { role: "range", type: "terminate" });
    const d = view(calm3, real.state, "flight").debrief!.anomalies;
    expect(d).toEqual([{ id: A, label: ANOMALY_LABEL, role: "range", scheduledT: t, real: true, active: true, activeAt: t, terminatedAt: t + 2000 }]);

    const unterm = toLiftoff(calm3, realSeed);
    toPlus(unterm, 60);
    expect(view(calm3, unterm.state, "ground").debrief!.anomalies[0]).toMatchObject({ real: true, activeAt: t, terminatedAt: null });

    const g = toLiftoff(calm3, glitchSeed);
    toPlus(g, 60);
    expect(view(calm3, g.state, "range").debrief!.anomalies[0]).toMatchObject({ real: false, active: true, terminatedAt: null });

    const q = toLiftoff(calm3, quietSeed);
    toPlus(q, 60);
    expect(view(calm3, q.state, "range").debrief!.anomalies[0]).toMatchObject({ scheduledT: null, active: false, activeAt: null, terminatedAt: null });
    expect(view(mvp, begin(mvp, 1).state, "flight")).not.toHaveProperty("debrief");
    const m = begin(mvp, 1);
    runBot(m);
    expect(view(mvp, m.state, "flight").debrief!.anomalies).toEqual([]);
  });
});

describe("the validator knows ascent and anomalies", () => {
  const bad = (edit: (r: any) => void, path: RegExp) => {
    const r = rawK3();
    edit(r);
    expect(() => parseSequence(r)).toThrow(SequenceError);
    expect(() => parseSequence(r)).toThrow(path);
  };
  it("accepts the shipped file and keeps ascentSec and anomalies off sequences that lack them", () => {
    expect(k3.ascentSec).toBe(60);
    expect(k3.anomalies).toHaveLength(1);
    expect(k3.countdownSec).toBe(300);
    expect(k3.holdBudgetSec).toBe(150);
    expect("ascentSec" in k2).toBe(false);
    expect("anomalies" in mvp).toBe(false);
  });
  it("rejects bad ones with a path", () => {
    bad((r) => { r.ascentSec = 0; }, /^ascentSec:/);
    bad((r) => { delete r.ascentSec; }, /^anomalies:.*ascentSec/);
    bad((r) => { r.anomalies[0].window = [0, 40]; }, /anomalies\[0\]\.window\[0\]/);
    bad((r) => { r.anomalies[0].window = [5, 60]; }, /anomalies\[0\]\.window\[1\]/);
    bad((r) => { r.anomalies[0].value = "nope"; }, /anomalies\[0\]\.value.*unknown value/);
    bad((r) => { r.anomalies[0].value = "tank_pressure"; }, /anomalies\[0\]\.value.*range console/);
    bad((r) => { r.anomalies[0].driftPerSec = 0; }, /anomalies\[0\]\.driftPerSec/);
    bad((r) => { r.anomalies[0].driftPerSec = 1; }, /anomalies\[0\]\.driftPerSec.*glitch would reach 8/);
    bad((r) => { r.anomalies[0].chance = 2; }, /anomalies\[0\]\.chance/);
    bad((r) => { r.anomalies[0].crossCheck.role = "range"; }, /anomalies\[0\]\.crossCheck\.role.*different console/);
    bad((r) => { r.roles = ["flight", "propulsion", "ground", "weather"]; }, /role "range" is not in the sequence's roles/);
    bad((r) => { r.values.impact_offset.driftPerSec = 0.1; }, /anomalies\[0\]\.value.*no drift/);
  });
});

describe("kestrel3 is winnable", () => {
  const N = 150;
  /** A crew that reads the weather like kestrel2's, and whose Range Safety terminates only when propulsion's cross-check reads abnormal. */
  function play(seed: number, attentive: boolean) {
    const run = begin(k3, seed);
    const amber = () => weatherAmber(run.state, k3);
    runBot(run, {
      report: (role) => (role === "weather" && amber() ? "nogo" : "go"),
      repoll: () => !amber(),
      canResume: () => !amber(),
      holdWhen: () => amber() && run.state.polls.poll_2!.status === "closed" && run.state.tMs > -60_000,
      onAscent: (r) => {
        if (!attentive) return;
        const abnormal = view(k3, r.state, "propulsion").crossChecks.some((c) => c.label === CROSS_LABEL && c.reading === "abnormal");
        if (abnormal) act(r, { role: "range", type: "terminate" });
      },
    });
    return run;
  }

  it("an attentive range officer wins or terminates correctly in at least 90% of seeds, and every flight that lifts off", () => {
    let liftoffs = 0;
    let good = 0;
    let wins = 0;
    let terminatedCorrectly = 0;
    const bad: string[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const run = play(seed, true);
      const o = run.state.outcome!;
      if (o.kind === "success") wins++;
      if (!run.events.some((e) => e.kind === "liftoff")) continue; // lost on the pad: a weather scrub or a closed window
      liftoffs++;
      const correct = o.kind === "terminated" && o.reasons[0]!.includes("correct call");
      if (correct) terminatedCorrectly++;
      if (o.kind === "success" || correct) good++;
      else bad.push(`${seed}: ${o.kind} ${o.reasons[0]}`);
    }
    expect(good / liftoffs, bad.join("; ")).toBeGreaterThanOrEqual(0.9);
    // lost on the pad (a closed launch window) is the only other way to lose, so the whole crew's record clears 90% too
    expect(good / N, "wins or correct terminations over every seed").toBeGreaterThanOrEqual(0.9);
    expect(terminatedCorrectly, "some real anomalies were terminated").toBeGreaterThan(5);
    expect(wins).toBeGreaterThan(40);
  }, 240_000);

  it("a range officer who never terminates loses real anomalies to a range violation, and only those", () => {
    let violations = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const run = play(seed, false);
      const o = run.state.outcome!;
      if (o.kind === "range_violation") {
        violations++;
        expect(run.state.anomalies[A]!.real).toBe(true);
      }
      if (!run.events.some((e) => e.kind === "liftoff")) continue;
      expect(o.kind === "success" || o.kind === "range_violation").toBe(true);
      if (run.state.anomalies[A]!.real && run.state.anomalies[A]!.scheduledT !== null) expect(o.kind).toBe("range_violation");
    }
    expect(violations).toBeGreaterThan(3);
  }, 120_000);

  it("a range officer who always terminates destroys a healthy vehicle in the seeds with no real anomaly", () => {
    const run = begin(calm3, quietSeed);
    runBot(run, { onAscent: (r) => { act(r, { role: "range", type: "terminate" }); } });
    expect(run.state.outcome!.kind).toBe("terminated");
    expect(run.state.outcome!.reasons[0]).toContain("healthy vehicle");
  });
});
