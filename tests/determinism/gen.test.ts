// D8 (Node half): native equals wasm for a generated world, and restoring a snapshot regenerates the
// pristine chunks exactly as they were.
import { describe, expect, it } from "vitest";
import { compare } from "./compare.ts";
import { gameScript, readWasm, sh, wasmPath } from "./helpers.ts";
import { run } from "./run.ts";
import { loadSim } from "../../shared/sim.ts";

const wasm = readWasm(wasmPath);

describe("D8 generation", () => {
  it("native Rust and wasm agree on the game world for 300 ticks", () => {
    const { script, path } = gameScript();
    const out = sh("cargo", ["run", "--quiet", "--release", "--manifest-path", "sim/Cargo.toml", "--example", "run_script", "--", path]);
    const native = (JSON.parse(out) as [number, string][]).map(([t, h]): [number, string] => [t, h]);
    const w = run(wasm, script).hashes;
    expect(native).toHaveLength(5);
    expect(compare({ hashes: native, finalChunkHashes: [] }, { hashes: w, finalChunkHashes: [] }, ["native", "wasm"])).toBeNull();
  });

  it("a restored snapshot regenerates pristine chunks: tick 0 is header-and-pickups-sized and round-trips", () => {
    const a = loadSim(wasm);
    a.init(77n, 1);
    const h0 = a.stateHash();
    const snap0 = a.snapshot();
    expect(snap0.length).toBeLessThan(2048); // no chunk changed yet: header plus the ~65 pickups
    const b = loadSim(wasm);
    b.restore(snap0);
    expect(b.stateHash()).toBe(h0);
    expect(Array.from(b.chunkHashes())).toEqual(Array.from(a.chunkHashes()));
  });

  it("after 300 ticks the snapshot is smaller than the world, restores to the same state, and keeps stepping identically", () => {
    const a = loadSim(wasm);
    a.init(77n, 1);
    for (let i = 0; i < 300; i++) a.step();
    const snap = a.snapshot();
    expect(snap.length).toBeLessThan(2048 * 1536 * 2);
    const b = loadSim(wasm);
    b.restore(snap);
    expect(b.stateHash()).toBe(a.stateHash());
    for (let i = 0; i < 120; i++) {
      a.step();
      b.step();
    }
    expect(b.stateHash()).toBe(a.stateHash());
    expect(Array.from(b.chunkHashes())).toEqual(Array.from(a.chunkHashes()));
  });
});
