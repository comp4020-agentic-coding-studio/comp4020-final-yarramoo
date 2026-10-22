// R0a: the sim's init takes config bytes and refuses a bad one (returns -1, which loadSim turns into a throw).
import { describe, expect, it } from "vitest";
import { CAVES_PVP, CLASSIC_SANDBOX, encodeConfig } from "../../shared/room.ts";
import { loadSim } from "../../shared/sim.ts";
import { wasmBytes } from "./helpers.ts";

describe("sim init with a room config", () => {
  it("accepts both presets and sizes the world from the config", () => {
    const a = loadSim(wasmBytes);
    a.init(1n, encodeConfig(CLASSIC_SANDBOX));
    expect([a.width(), a.height()]).toEqual([512, 512]);
    const b = loadSim(wasmBytes);
    b.init(5n, encodeConfig(CAVES_PVP));
    expect([b.width(), b.height()]).toEqual([2048, 1536]);
  });

  it("refuses bad configs and leaves any earlier world alone", () => {
    const sim = loadSim(wasmBytes);
    sim.init(1n, encodeConfig(CLASSIC_SANDBOX));
    const bad = (mutate: (b: Uint8Array) => void) => {
      const b = encodeConfig(CLASSIC_SANDBOX);
      mutate(b);
      expect(() => sim.init(1n, b)).toThrow(/-1/);
    };
    bad((b) => (b[0] = 2)); // version
    bad((b) => (b[12] = 1)); // reserved
    bad((b) => (b[1] = 7)); // terrain out of range
    bad((b) => (b[11] = 99)); // max players
    expect(() => sim.init(1n, encodeConfig(CLASSIC_SANDBOX).slice(0, 15))).toThrow(/-1/);
    expect(() => sim.init(1n, new Uint8Array(4096))).toThrow(/-1/);
    expect(sim.width()).toBe(512); // still the old world
  });

  it("R1: every (terrain, size) combination generates, not just the two original presets", () => {
    const dims: [number, number][] = [[512, 512], [1024, 768], [2048, 1536]];
    for (let terrain = 0; terrain <= 2; terrain++) {
      for (let size = 0; size <= 2; size++) {
        const sim = loadSim(wasmBytes);
        const cfg = { ...CLASSIC_SANDBOX, terrain, size, avatars: terrain === 0 ? 1 : 0 };
        sim.init(1n, encodeConfig(cfg));
        expect([sim.width(), sim.height()]).toEqual(dims[size]);
      }
    }
  });
});
