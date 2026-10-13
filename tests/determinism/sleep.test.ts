// D7 in TypeScript: the wasm build gives identical hashes with chunk sleeping on and off.
import { describe, expect, it } from "vitest";
import { encodePaint, hex } from "../../shared/inputs.ts";
import { compare } from "./compare.ts";
import { readWasm, wasmPath } from "./helpers.ts";
import { run, type ScriptLike } from "./run.ts";

const wasm = readWasm(wasmPath);
const paint = (mat: number, x0: number, y0: number, x1: number, y1: number, r: number) =>
  hex(encodePaint(1, mat, x0, y0, x1, y1, r));

/** Settle piles, then disturb them: paint into a quiet region, blow up across a chunk edge, flood across one. */
function script(kind: number, ticks: number): ScriptLike {
  const at: [number, string][] = [
    [1, paint(4, 100, 100, 156, 100, 6)],
    [1, paint(5, 300, 60, 300, 140, 5)],
    [2, paint(3, 20, 480, 490, 480, 3)],
    [400, paint(4, 110, 40, 110, 60, 8)],
    [500, paint(13, 140, 300, 200, 300, 2)],
    [505, paint(10, 200, 300, 202, 300, 1)],
    [700, paint(2, 230, 400, 330, 400, 2)],
    [702, paint(5, 245, 380, 250, 380, 3)],
    [900, paint(14, 60, 200, 60, 205, 4)],
    [905, paint(5, 66, 200, 66, 205, 4)],
    [1300, paint(0, 90, 90, 160, 120, 10)],
  ];
  const inputs: Record<string, string[]> = {};
  for (const [t, h] of at) (inputs[String(t)] ??= []).push(h);
  return { seed: "11", world_kind: kind, ticks, inputs };
}

describe("D7: sleeping is invisible", () => {
  it("sandbox: on and off agree at every checkpoint", () => {
    const s = script(0, 1500);
    const on = run(wasm, s, {}, { sleep: true });
    const off = run(wasm, s, {}, { sleep: false });
    expect(on.hashes).toHaveLength(25);
    expect(compare(on, off, ["sleep on", "sleep off"])).toBeNull();
  });

  it("game world: on and off agree (generated water, lava and sand settle and sleep)", () => {
    const s = script(1, 480);
    const on = run(wasm, s, {}, { sleep: true, hashTick0: true });
    const off = run(wasm, s, {}, { sleep: false, hashTick0: true });
    expect(on.hashes).toHaveLength(9);
    expect(compare(on, off, ["sleep on", "sleep off"])).toBeNull();
  });
});
