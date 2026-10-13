import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePaint } from "../../shared/inputs.ts";
import { loadSim } from "../../shared/sim.ts";
import { readWasm, wasmPath } from "./helpers.ts";

// The sandbox deployed at 22ec30b keeps its world in v1 snapshots on the Fly volume, and D-014 rules out
// resetting it. Two different claims, kept apart (D-081):
// - DATA: this build restores a snapshot that build wrote to exactly the same state. Must hold forever,
//   or the live world is lost.
// - RULES: from there the two builds step the same way only until a gameplay rule changes on purpose.
//   Liquid dispersion (D-081) is such a change, so they now diverge. A future rule change must update
//   RULES_CHANGED_BY rather than make this pass by accident.
const DEPLOYED = "tests/fixtures/sim-v1-deployed.wasm";
const RULES_CHANGED_BY = "D-081: liquids slide sideways to find their level";

function deployedSnapshot() {
  const old = loadSim(new Uint8Array(readFileSync(DEPLOYED)));
  old.init(77n, 0);
  for (let t = 0; t < 400; t++) {
    if (t % 10 === 0) old.pushInput(encodePaint(1, [4, 5, 10, 13, 14, 7][t % 6], 40 + t, 60, 60 + t, 200, 6));
    old.step();
  }
  return old;
}

describe("compatibility with the deployed sandbox", () => {
  it("DATA: restores a real v1 snapshot from the 22ec30b build to exactly the same state", () => {
    const old = deployedSnapshot();
    const snap = old.snapshot();
    expect(snap[4] | (snap[5] << 8)).toBe(1);
    const neu = loadSim(readWasm(wasmPath));
    neu.init(1n, 0);
    neu.restore(snap);
    expect(neu.tick()).toBe(old.tick());
    expect(neu.stateHash()).toBe(old.stateHash());
  });

  it(`RULES: steps differently from the deployed build only because of ${RULES_CHANGED_BY}`, () => {
    const old = deployedSnapshot();
    const neu = loadSim(readWasm(wasmPath));
    neu.init(1n, 0);
    neu.restore(old.snapshot());
    for (let t = 0; t < 300; t++) {
      old.step();
      neu.step();
    }
    // Liquids are in this world (water and lava are painted), so the deliberate change shows.
    expect(neu.stateHash()).not.toBe(old.stateHash());
  });
});
