import { describe, expect, it } from "vitest";
import { compare } from "./compare.ts";
import { castScript, readWasm, sharedScript, wasmPath } from "./helpers.ts";
import { run } from "./run.ts";

const wasm = readWasm(wasmPath);
const { script } = sharedScript();

describe("Node determinism", () => {
  it("D1: two fresh instances, same script, identical", () => {
    const a = run(wasm, script);
    const b = run(wasm, script);
    expect(a.hashes).toHaveLength(30);
    expect(compare(a, b, ["run1", "run2"])).toBeNull();
  });

  it("D6: 1 step per call, 7 per call and a catch-up burst agree", () => {
    const one = run(wasm, script, {}, { batching: { kind: "each" } });
    const seven = run(wasm, script, {}, { batching: { kind: "batch", k: 7 } });
    const burst = run(wasm, script, {}, { batching: { kind: "burst", at: 500, len: 600 } });
    expect(compare(one, seven, ["each", "k=7"])).toBeNull();
    expect(compare(one, burst, ["each", "burst"])).toBeNull();
  });

  // The same two properties with players casting in the game world (projectiles in entity state).
  const cast = castScript().script;
  it("D1 with casts: two fresh instances agree, and bolts really flew", () => {
    const a = run(readWasm(wasmPath), cast);
    const b = run(readWasm(wasmPath), cast);
    expect(compare(a, b, ["run1", "run2"])).toBeNull();
    const n = Object.values(cast.inputs).flat().filter((h) => h.startsWith("04")).length;
    expect(n).toBeGreaterThan(20);
  });

  it("D6 with casts: 1 step per call, 7 per call and a catch-up burst agree", () => {
    const one = run(wasm, cast, {}, { batching: { kind: "each" } });
    const seven = run(wasm, cast, {}, { batching: { kind: "batch", k: 7 } });
    const burst = run(wasm, cast, {}, { batching: { kind: "burst", at: 300, len: 400 } });
    expect(compare(one, seven, ["each", "k=7"])).toBeNull();
    expect(compare(one, burst, ["each", "burst"])).toBeNull();
  });

  it("comparator reports the first diverging tick and chunks", () => {
    const a = run(wasm, script);
    const b = structuredClone(a);
    b.hashes[7][1] = "deadbeefdeadbeef";
    b.finalChunkHashes[3] = "0".repeat(16);
    const d = compare(a, b);
    expect(d?.tick).toBe(a.hashes[7][0]);
    expect(d?.chunks).toEqual([3]);
  });
});
