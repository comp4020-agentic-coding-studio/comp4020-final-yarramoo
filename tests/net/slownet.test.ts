import { describe, expect, it } from "vitest";
import { nextSlow, SLOW_IDLE, slowText, type SlowSample, type SlowState } from "../../client/slownet.ts";

const LIVE = { state: "live", pingMs: 60, stepsPerSec: 60, buffered: 0 };
/** Feed one sample every 500 ms (the worker's stats cadence) from `from` for `secs` seconds; return the states. */
function run(st: SlowState, from: number, secs: number, s: Partial<SlowSample>): { st: SlowState; shown: (string | null)[]; end: number } {
  const shown: (string | null)[] = [];
  let ms = from;
  for (let i = 0; i < secs * 2; i++) {
    ms += 500;
    st = nextSlow(st, { ...LIVE, ...s, ms });
    shown.push(st.shown);
  }
  return { st, shown, end: ms };
}

describe("nextSlow: latency", () => {
  it("never shows on a clean link, nor on one measured under heavy machine load (ping 350)", () => {
    expect(run(SLOW_IDLE, 0, 60, { pingMs: 169 }).shown.every((x) => x === null)).toBe(true);
    expect(run(SLOW_IDLE, 0, 60, { pingMs: 350 }).shown.every((x) => x === null)).toBe(true);
  });
  it("shows a high round trip only once it has lasted 4 s (two pings): one stale spike stays hidden", () => {
    const spike = run(SLOW_IDLE, 0, 2, { pingMs: 2031 });
    expect(spike.shown.every((x) => x === null)).toBe(true);
    const back = run(spike.st, spike.end, 30, { pingMs: 6 });
    expect(back.shown.every((x) => x === null)).toBe(true);
    const slow = run(SLOW_IDLE, 0, 5, { pingMs: 930 });
    expect(slow.shown.slice(0, 7).every((x) => x === null)).toBe(true);
    expect(slow.shown.at(-1)).toBe("latency");
  });
  it("hides only after 6 s under 250 ms, so a jittery 300 ms link does not flicker", () => {
    const on = run(SLOW_IDLE, 0, 5, { pingMs: 700 });
    expect(on.st.shown).toBe("latency");
    // Measured loss3: 190-200 ms for 4 s between 400-700 ms readings.
    let st = on.st, t = on.end;
    for (const [ping, secs] of [[190, 2], [200, 2], [557, 2], [384, 2], [200, 4], [497, 2]] as const) {
      const r = run(st, t, secs, { pingMs: ping });
      expect(r.shown.every((x) => x === "latency")).toBe(true);
      st = r.st;
      t = r.end;
    }
    const off = run(st, t, 7, { pingMs: 4 });
    expect(off.shown.at(-1)).toBeNull();
    expect(off.shown.slice(0, 11).every((x) => x === "latency")).toBe(true);
  });
  it("treats ping 0 (no reading yet) as unknown, not good or bad", () => {
    const on = run(SLOW_IDLE, 0, 5, { pingMs: 900 });
    expect(run(on.st, on.end, 20, { pingMs: 0 }).shown.every((x) => x === "latency")).toBe(true);
    expect(run(SLOW_IDLE, 0, 20, { pingMs: 0 }).shown.every((x) => x === null)).toBe(true);
  });
});

describe("nextSlow: stall", () => {
  it("shows when live but no tick has arrived for 1.5 s, and not on a CPU-starved client that has ticks queued", () => {
    const r = run(SLOW_IDLE, 0, 3, { stepsPerSec: 0, buffered: 0 });
    expect(r.shown.slice(0, 2).every((x) => x === null)).toBe(true);
    expect(r.shown.at(-1)).toBe("stall");
    expect(run(SLOW_IDLE, 0, 10, { stepsPerSec: 0, buffered: 40 }).shown.every((x) => x === null)).toBe(true);
    // The lowest clean-link rate measured under load was 17 steps/s over a 500 ms window.
    expect(run(SLOW_IDLE, 0, 10, { stepsPerSec: 17, buffered: 0 }).shown.every((x) => x === null)).toBe(true);
  });
  it("outranks latency, and falls back to it when ticks flow again but the round trip is still high", () => {
    const lat = run(SLOW_IDLE, 0, 5, { pingMs: 900 });
    const stall = run(lat.st, lat.end, 2, { pingMs: 900, stepsPerSec: 0 });
    expect(stall.st.shown).toBe("stall");
    const flowing = run(stall.st, stall.end, 3, { pingMs: 900, stepsPerSec: 60 });
    expect(flowing.shown.at(-1)).toBe("latency");
    // A good round trip after the stall still owes the latency notice its 6 s of good readings (no flicker).
    const clean = run(stall.st, stall.end, 7, { pingMs: 40, stepsPerSec: 60 });
    expect(clean.shown[1]).toBe("stall"); // STALL_OFF_HOLD_MS of flowing ticks first
    expect(clean.shown[3]).toBe("latency");
    expect(clean.shown.at(-1)).toBeNull();
  });
});

describe("nextSlow: other states", () => {
  it("hides and forgets while catching up, reconnecting or rejected (those have their own card and note)", () => {
    const on = run(SLOW_IDLE, 0, 5, { pingMs: 900 });
    for (const state of ["catching-up", "reconnecting", "connecting", "rejected"]) {
      const st = nextSlow(on.st, { ...LIVE, state, pingMs: 900, ms: on.end + 500 });
      expect(st).toEqual(SLOW_IDLE);
    }
  });
});

describe("slowText", () => {
  it("names the reason plainly and rounds the round trip", () => {
    expect(slowText("latency", 934)).toEqual({ title: "Slow connection", detail: "930 ms round trip: others see your moves late" });
    expect(slowText("latency", 2179)).toEqual({ title: "Slow connection", detail: "2.2 s round trip: others see your moves late" });
    expect(slowText("stall", 400).title).toBe("Connection stalled");
  });
});
