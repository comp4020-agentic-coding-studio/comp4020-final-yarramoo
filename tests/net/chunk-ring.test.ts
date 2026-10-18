// The client's ring of per-chunk hashes (D-126): the last CHUNK_RING checkpoints, read-only, for a desync diagnosis.
import { describe, expect, it } from "vitest";
import { CHUNK_RING, Lockstep, reactToTick } from "../../client/lockstep.ts";
import { HASH_EVERY } from "../../shared/protocol.ts";
import { loadSim } from "../../shared/sim.ts";
import { wasmBytes } from "./helpers.ts";

function run(ticks: number): Lockstep {
  const sim = loadSim(wasmBytes);
  sim.init(1n, 0);
  const ls = new Lockstep(sim);
  for (let t = 1; t <= ticks; t++) {
    ls.push(t, []);
    ls.run(1);
    reactToTick(ls, t, 0);
  }
  return ls;
}

describe("chunk-hash ring", () => {
  it("keeps the last 5 checkpoints, and a tick that left the ring is unavailable", () => {
    expect(CHUNK_RING).toBe(5);
    const ls = run(HASH_EVERY * 8);
    for (let k = 4; k <= 8; k++) expect(ls.chunkHashesAt(k * HASH_EVERY)?.length, `checkpoint ${k}`).toBe(64);
    for (let k = 1; k <= 3; k++) expect(ls.chunkHashesAt(k * HASH_EVERY)).toBeNull();
    expect(ls.chunkHashesAt(HASH_EVERY * 8 + 1)).toBeNull();
  });

  it("holds the hashes as they were at that tick, not a live view", () => {
    const ls = run(HASH_EVERY * 2);
    const at = ls.chunkHashesAt(HASH_EVERY)!;
    const copy = BigUint64Array.from(at);
    expect(Array.from(ls.chunkHashesAt(HASH_EVERY)!)).toEqual(Array.from(copy));
  });

  it("does not record a tick that is not a checkpoint or is still being replayed", () => {
    const sim = loadSim(wasmBytes);
    sim.init(1n, 0);
    const ls = new Lockstep(sim);
    ls.catchUpTarget = HASH_EVERY * 2;
    for (let t = 1; t <= HASH_EVERY * 3; t++) {
      ls.push(t, []);
      ls.run(1);
      reactToTick(ls, t, 0);
    }
    expect(ls.chunkHashesAt(HASH_EVERY)).toBeNull();
    expect(ls.chunkHashesAt(HASH_EVERY * 2)).toBeNull();
    expect(ls.chunkHashesAt(HASH_EVERY * 3)).not.toBeNull();
    expect(ls.chunkHashesAt(HASH_EVERY + 1)).toBeNull();
  });
});
