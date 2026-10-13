import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePaint } from "../../shared/inputs.ts";
import { loadSim } from "../../shared/sim.ts";
import { readWasm, wasmPath } from "./helpers.ts";

// The sandbox deployed at 22ec30b keeps its world in v1 snapshots on the Fly volume, and D-014 rules
// out resetting it. This build must restore one written by THAT wasm and then step identically to it.
const DEPLOYED = "tests/fixtures/sim-v1-deployed.wasm";

describe("compatibility with the deployed sandbox", () => {
  it("restores a real v1 snapshot from the 22ec30b build and steps identically", () => {
    const old = loadSim(new Uint8Array(readFileSync(DEPLOYED)));
    old.init(77n, 0);
    for (let t = 0; t < 400; t++) {
      if (t % 10 === 0) old.pushInput(encodePaint(1, [4, 5, 10, 13, 14, 7][t % 6], 40 + t, 60, 60 + t, 200, 6));
      old.step();
    }
    const snap = old.snapshot();
    expect(snap[4] | (snap[5] << 8)).toBe(1);
    const neu = loadSim(readWasm(wasmPath));
    neu.init(1n, 0);
    neu.restore(snap);
    expect(neu.stateHash()).toBe(old.stateHash());
    for (let t = 0; t < 300; t++) {
      old.step();
      neu.step();
    }
    expect(neu.stateHash()).toBe(old.stateHash());
  });
});
