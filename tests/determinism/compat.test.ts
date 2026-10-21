import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePaint } from "../../shared/inputs.ts";
import { loadSim } from "../../shared/sim.ts";
import { readWasm, wasmPath } from "./helpers.ts";

// The sandbox deployed at 22ec30b kept its world in v1 snapshots on the Fly volume (D-014). R0a (snapshot format 4,
// the config in the header) deliberately ends that: the game is not live, so a stored v1 snapshot is refused
// rather than migrated. This test keeps the old wasm and proves the refusal is clean (an error, never a
// half-restored world). The old DATA and RULES claims (D-081) no longer apply and were removed with the format.
const DEPLOYED = "tests/fixtures/sim-v1-deployed.wasm";

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
  it("a real v1 snapshot from the 22ec30b build is refused by the format-4 sim, leaving the sim usable", () => {
    const old = deployedSnapshot();
    const snap = old.snapshot();
    expect(snap[4] | (snap[5] << 8)).toBe(1);
    const neu = loadSim(readWasm(wasmPath));
    neu.init(1n, 0);
    const before = neu.stateHash();
    expect(() => neu.restore(snap)).toThrow();
    expect(neu.stateHash()).toBe(before);
  });
});
