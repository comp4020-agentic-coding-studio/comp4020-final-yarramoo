import { describe, expect, it } from "vitest";
import { view } from "./view.ts";
import { act, advanceToT, begin, findSeed, loadMvp, runBot } from "./testutil.ts";
import type { Role, State } from "./types.ts";

const seq = loadMvp();
const BOTH_REAL = findSeed(
  seq,
  (s) => s.faults.vent_stuck!.scheduledT !== null && s.faults.vent_stuck!.real && s.faults.bus_sag!.scheduledT !== null && s.faults.bus_sag!.real,
);

function midMission(seed = BOTH_REAL) {
  const run = runBot(begin(seq, seed), { fix: false, untilTMs: -60_000 });
  expect(Object.values(run.state.faults).every((f) => f.active)).toBe(true);
  return run;
}

const propulsionOnly = ["tank_pressure", "Propellant tank pressure", "Tank vent valve position unconfirmed", "fix_vent", "Cycle tank vent valve", "Umbilical bus ammeter", "Chill engine", "Prime engine feed lines", "Arm igniter circuit"];
const groundOnly = ["bus_voltage", "Pad power bus B", "Pad bus B voltage sag", "fix_bus", "Switch to backup power bus", "Vent line temperature", "Retract crew access arm", "Arm flame-trench", "Confirm range tracking"];

describe("view redaction", () => {
  it("a propulsion view holds no ground or flight-only data", () => {
    const text = JSON.stringify(view(seq, midMission().state, "propulsion"));
    for (const secret of groundOnly) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain("Give launch authority");
    expect(text).toContain("tank_pressure");
    expect(text).toContain("Umbilical bus ammeter"); // propulsion is the cross-check for the bus
  });

  it("a ground view holds no propulsion or flight-only data", () => {
    const text = JSON.stringify(view(seq, midMission().state, "ground"));
    for (const secret of propulsionOnly) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain("Give launch authority");
    expect(text).toContain("bus_voltage");
    expect(text).toContain("Vent line temperature");
  });

  it("the flight view has the master checklist but no values, faults or cross-checks", () => {
    const v = view(seq, midMission().state, "flight");
    const text = JSON.stringify(v);
    expect(v.checklist).toHaveLength(seq.steps.length);
    expect(v.checklist!.map((c) => c.label)).toContain("Chill engine to start temperature");
    expect(v.values).toEqual([]);
    expect(v.cautions).toEqual([]);
    expect(v.crossChecks).toEqual([]);
    for (const secret of ["tank_pressure", "bus_voltage", "Propellant tank pressure", "Pad power bus B", "Tank vent valve position unconfirmed", "Pad bus B voltage sag", "Vent line temperature", "Umbilical bus ammeter"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("non-flight views carry no checklist and no other console's step ids", () => {
    const s = midMission().state;
    for (const role of ["propulsion", "ground"] as Role[]) {
      const v = view(seq, s, role);
      expect(v.checklist).toBeUndefined();
      for (const st of v.steps) expect(seq.steps.find((x) => x.id === st.id)!.role).toBe(role);
    }
  });

  it("never says real or glitch, nor what a seat was showing, while the mission runs", () => {
    const run = runBot(begin(seq, BOTH_REAL), { fix: false, untilTMs: -30_000 });
    expect(run.state.polls.poll_1!.status).toBe("closed");
    for (const role of seq.roles) {
      const text = JSON.stringify(view(seq, run.state, role));
      expect(text).not.toMatch(/"real"|glitch|"showing"|scheduledT|debrief/i);
    }
  });

  it("a real fault and a glitch look the same on the faulted console", () => {
    const real = findSeed(seq, (s) => s.faults.vent_stuck!.scheduledT !== null && s.faults.vent_stuck!.real && s.faults.bus_sag!.scheduledT === null);
    const glitch = findSeed(seq, (s) => s.faults.vent_stuck!.scheduledT !== null && !s.faults.vent_stuck!.real && s.faults.bus_sag!.scheduledT === null);
    const caution = (seed: number) => {
      const run = runBot(begin(seq, seed), { fix: false, untilTMs: -105_000 });
      return view(seq, run.state, "propulsion").cautions;
    };
    expect(caution(real)).toEqual(["Tank vent valve position unconfirmed"]);
    expect(caution(glitch)).toEqual(["Tank vent valve position unconfirmed"]);
  });

  it("the cross-check reveals the truth: abnormal for real, normal for a glitch, normal again once fixed", () => {
    const check = (state: State) => view(seq, state, "ground").crossChecks.map((c) => c.reading);
    const realSeed = findSeed(seq, (s) => s.faults.vent_stuck!.scheduledT !== null && s.faults.vent_stuck!.real);
    const glitchSeed = findSeed(seq, (s) => s.faults.vent_stuck!.scheduledT !== null && !s.faults.vent_stuck!.real);
    const real = begin(seq, realSeed);
    const glitch = begin(seq, glitchSeed);
    expect(check(real.state)).toEqual(["normal"]);
    for (const run of [real, glitch]) runBot(run, { fix: false, untilTMs: -105_000 });
    expect(check(real.state)).toEqual(["abnormal"]);
    expect(check(glitch.state)).toEqual(["normal"]);
    act(real, { role: "propulsion", type: "step", stepId: "fix_vent" });
    expect(check(real.state)).toEqual(["normal"]);
    expect(view(seq, real.state, "propulsion").cautions).toEqual([]);
  });

  it("shows own steps with waitingOn, hiding other consoles' step labels", () => {
    const run = begin(seq, BOTH_REAL);
    advanceToT(run, -235);
    const v = view(seq, run.state, "propulsion");
    const tank = v.steps.find((s) => s.id === "tank_pressurise")!;
    expect(tank.status).toBe("locked");
    expect(tank.waitingOn).toEqual([{ role: "ground", label: null }]);
    expect(tank.window).toEqual([-230, -120]);
  });

  it("polls show who reported what but never what they were showing", () => {
    const run = runBot(begin(seq, BOTH_REAL), { fix: false, untilTMs: -30_000 });
    const poll = view(seq, run.state, "ground").polls.find((p) => p.id === "poll_1")!;
    expect(poll.reports).toEqual({ propulsion: "go", ground: "go" });
    expect(poll.myReport).toBe("go");
    expect(view(seq, run.state, "flight").polls[0]!.myReport).toBeNull();
  });

  it("a finished mission carries a debrief with real/glitch and reported/showing", () => {
    const run = runBot(begin(seq, BOTH_REAL), { fix: false });
    expect(run.state.phase).toBe("done");
    const v = view(seq, run.state, "ground");
    expect(v.outcome!.kind).toBe("explosion");
    expect(v.debrief!.faults.every((f) => f.real)).toBe(true);
    expect(v.debrief!.polls[0]!.reports.propulsion).toMatchObject({ report: "go", showing: "caution" });
  });

  it("views are plain JSON and do not alias engine state", () => {
    const run = midMission();
    const v = view(seq, run.state, "flight");
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    const before = structuredClone(run.state);
    v.outcome = null;
    v.polls[0]!.reports.ground = "nogo";
    expect(run.state).toEqual(before);
  });
});
