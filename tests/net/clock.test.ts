import { describe, expect, it } from "vitest";
import { TickClock, type ClosedTick } from "../../server/clock.ts";

const inp = (n: number) => ({ player: n, kind: 5, payload: new Uint8Array([n]) });

function setup() {
  let t = 1000;
  const closed: ClosedTick[] = [];
  const clock = new TickClock(() => t, (c) => closed.push(c));
  return { clock, closed, at: (ms: number) => (t = ms) };
}

describe("TickClock", () => {
  it("closes ticks on the 60 Hz boundary", () => {
    const { clock, closed, at } = setup();
    clock.resume();
    at(1000 + 16);
    clock.advance();
    expect(closed).toHaveLength(0);
    at(1000 + 17); // 17 * 60 / 1000 = 1.02
    clock.advance();
    expect(closed.map((c) => c.tick)).toEqual([1]);
  });

  it("puts an input arriving while the clock reads c into tick c+1, in arrival order", () => {
    const { clock, closed, at } = setup();
    clock.resume();
    at(1000 + 20); // reads 1
    expect(clock.stamp(inp(1))).toBe(2);
    expect(clock.stamp(inp(2))).toBe(2);
    expect(closed.map((c) => c.tick)).toEqual([1]);
    expect(closed[0].inputs).toHaveLength(0);
    at(1000 + 34); // reads 2
    clock.advance();
    expect(closed[1].tick).toBe(2);
    expect(closed[1].inputs.map((i) => i.player)).toEqual([1, 2]);
  });

  it("an input after a late timer is stamped after the ticks the clock has passed", () => {
    const { clock, closed, at } = setup();
    clock.resume();
    at(1000 + 100); // reads 6, timer never ran
    expect(clock.stamp(inp(1))).toBe(7);
    expect(closed.map((c) => c.tick)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(closed.every((c) => c.inputs.length === 0)).toBe(true);
  });

  it("closes every tick in order across a long stall", () => {
    const { clock, closed, at } = setup();
    clock.resume();
    at(1000 + 5000);
    clock.advance();
    expect(closed.map((c) => c.tick)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it("pauses, re-bases on resume and keeps numbering continuous", () => {
    const { clock, closed, at } = setup();
    clock.resume();
    at(1000 + 50); // reads 3
    clock.pause();
    expect(closed.map((c) => c.tick)).toEqual([1, 2, 3]);
    at(1000 + 10_000);
    clock.advance();
    expect(closed).toHaveLength(3);
    clock.resume();
    clock.advance();
    expect(closed).toHaveLength(3);
    at(1000 + 10_000 + 17);
    clock.advance();
    expect(closed.map((c) => c.tick)).toEqual([1, 2, 3, 4]);
  });

  it("reset pauses, drops open inputs and restarts numbering at 0", () => {
    const { clock, closed, at } = setup();
    clock.resume();
    at(1000 + 100);
    clock.stamp(inp(1)); // closes ticks 1..6, leaves inp(1) open for tick 7
    const before = closed.length;
    expect(before).toBe(6);
    clock.reset();
    expect(clock.isPaused).toBe(true);
    expect(clock.lastClosed).toBe(0);
    at(1000 + 5000);
    clock.advance(); // paused: nothing closes
    expect(closed).toHaveLength(before);
    clock.resume();
    at(1000 + 5000 + 17);
    clock.advance();
    // The dropped input is gone and numbering restarted at 1.
    expect(closed.slice(before)).toEqual([{ tick: 1, inputs: [] }]);
  });
});
