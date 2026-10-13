// Review M4b S2 and S3: stale Knocks after a stall, and the cast rate against the server's input limit.
import { describe, expect, it } from "vitest";
import { Lockstep, knockIsFresh } from "../../client/lockstep.ts";
import { loadSim } from "../../shared/sim.ts";
import { wasmBytes } from "./helpers.ts";

describe("S2: a burst of buffered ticks applies only fresh Knocks", () => {
  it("of 300 buffered ticks, only those within a few ticks of the live edge count", () => {
    const ls = new Lockstep(loadSim(wasmBytes));
    ls.sim.init(1n, 1);
    for (let t = 1; t <= 300; t++) ls.push(t, []);
    const fresh: number[] = [];
    const all: number[] = [];
    ls.onStepped = (tick) => {
      all.push(tick);
      if (knockIsFresh(tick, ls.latestClosed)) fresh.push(tick);
    };
    ls.run(1000); // the stalled tab catches up in one frame
    expect(all).toHaveLength(300);
    expect(fresh[0]).toBe(300 - 6);
    expect(fresh).toHaveLength(7);
  });
});
