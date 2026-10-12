import { describe, expect, it } from "vitest";
import { parseSequence, SequenceError } from "./sequence.ts";
import { loadMvp } from "./testutil.ts";
import { readFileSync } from "node:fs";

const raw = (): any =>
  JSON.parse(readFileSync(new URL("../../data/sequences/mvp.json", import.meta.url), "utf8"));

function pathOf(mutate: (r: any) => void): string {
  const r = raw();
  mutate(r);
  try {
    parseSequence(r);
  } catch (e) {
    expect(e).toBeInstanceOf(SequenceError);
    return (e as SequenceError).path;
  }
  throw new Error("expected the sequence to be rejected");
}

describe("sequence validator", () => {
  it("accepts data/sequences/mvp.json", () => {
    const seq = loadMvp();
    expect(seq.steps.length).toBeGreaterThanOrEqual(10);
    expect(seq.polls).toHaveLength(2);
    expect(seq.faults).toHaveLength(2);
  });

  it("rejects an after reference to an unknown id, with the path", () => {
    expect(pathOf((r) => (r.steps[2].after = ["nope"]))).toBe("steps[2].after[0]");
    expect(pathOf((r) => (r.polls[0].after = ["nope"]))).toBe("polls[0].after[0]");
  });

  it("rejects dependency cycles and self-dependency", () => {
    expect(pathOf((r) => (r.steps[0].after = ["tank_pressurise"]))).toMatch(/^steps\[\d+\]\.after$/);
    expect(pathOf((r) => (r.steps[0].after = ["arm_retract"]))).toBe("steps[0].after[0]");
  });

  it("rejects cycles that run through a poll", () => {
    // poll_1 waits on tank_pressurise; make tank_pressurise wait on poll_1
    expect(pathOf((r) => (r.steps[2].after = ["poll_1"]))).toMatch(/after$/);
  });

  it("rejects badly ordered or out-of-range windows", () => {
    expect(pathOf((r) => (r.steps[0].window = [-100, -200]))).toBe("steps[0].window");
    expect(pathOf((r) => (r.steps[0].window = [-300, -200]))).toBe("steps[0].window[0]");
    expect(pathOf((r) => (r.steps[0].window = [-100, 5]))).toBe("steps[0].window[1]");
    expect(pathOf((r) => (r.polls[0].window = [-30, -40]))).toBe("polls[0].window");
    expect(pathOf((r) => (r.faults[0].window = [-100, -120]))).toBe("faults[0].window");
  });

  it("rejects bad fault references", () => {
    expect(pathOf((r) => (r.faults[0].fixStep = "nope"))).toBe("faults[0].fixStep");
    expect(pathOf((r) => (r.faults[0].fixStep = "arm_retract"))).toBe("faults[0].fixStep");
    expect(pathOf((r) => (r.faults[0].effect.value = "nope"))).toBe("faults[0].effect.value");
    expect(pathOf((r) => (r.faults[0].crossCheck.role = "propulsion"))).toBe("faults[0].crossCheck.role");
    expect(pathOf((r) => (r.faults[0].chance = 1.5))).toBe("faults[0].chance");
  });

  it("rejects a required fix step", () => {
    expect(pathOf((r) => (r.steps.find((s: any) => s.id === "fix_vent").required = true))).toBe("faults[0].fixStep");
  });

  it("rejects duplicate ids and unknown roles and effects", () => {
    expect(pathOf((r) => (r.steps[1].id = "arm_retract"))).toBe("steps[1].id");
    expect(pathOf((r) => (r.polls[0].id = "arm_retract"))).toBe("polls[0].id");
    expect(pathOf((r) => (r.steps[0].role = "weather"))).toBe("steps[0].role");
    expect(pathOf((r) => (r.steps[2].effects[0].value = "nope"))).toBe("steps[2].effects[0].value");
    expect(pathOf((r) => (r.roles = ["propulsion", "ground"]))).toBe("roles");
  });

  it("rejects non-objects and bad value ranges", () => {
    expect(() => parseSequence(null)).toThrow(/^\$: /);
    expect(() => parseSequence([])).toThrow(SequenceError);
    expect(pathOf((r) => (r.values.tank_pressure.limit = [240, 335]))).toBe("values.tank_pressure.limit");
    expect(pathOf((r) => (r.values.tank_pressure.start = 9999))).toBe("values.tank_pressure.start");
    expect(pathOf((r) => (r.countdownSec = 0))).toBe("countdownSec");
  });
});
