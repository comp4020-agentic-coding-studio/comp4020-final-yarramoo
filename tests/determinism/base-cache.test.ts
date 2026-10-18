import { expect, test } from "vitest";
import { loadSim } from "../../shared/sim.ts";
import { readWasm, wasmPath } from "./helpers.ts";

// D-088: init then restore, and a second restore, reuse the cached base; a different seed must not.
test("a restore through the wasm ABI is the same on a cache hit, a miss and a cold sim", () => {
  const wasm = readWasm(wasmPath);
  const snaps = [7n, 8n].map((seed) => {
    const s = loadSim(wasm);
    s.init(seed, 1);
    for (let i = 0; i < 20; i++) s.step();
    return { seed, bytes: s.snapshot(), hash: s.stateHash() };
  });
  const warm = loadSim(wasm);
  warm.init(7n, 1);
  for (const k of [0, 1, 0, 1]) {
    warm.restore(snaps[k].bytes); // alternating seeds: hit, miss, miss, miss, never the wrong world
    expect(warm.stateHash()).toBe(snaps[k].hash);
  }
  warm.restore(snaps[1].bytes);
  warm.restore(snaps[1].bytes); // a hit
  expect(warm.stateHash()).toBe(snaps[1].hash);
  const cold = loadSim(wasm);
  cold.restore(snaps[0].bytes);
  expect(cold.stateHash()).toBe(snaps[0].hash);
}, 30_000);
