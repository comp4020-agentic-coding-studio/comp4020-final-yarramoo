// The chunk grid in shared/protocol.ts sets the CHUNK_HASHES frame cap and maps chunk indices to cells in a desync
// report. It is a copy of the sim's layout, so check it against the real wasm: chunkHashes() returns one hash per
// chunk, and width()/height() give the world, so a sim change to CHUNK or a world size fails here.
import { describe, expect, it } from "vitest";
import { loadSim } from "../../shared/sim.ts";
import { chunkCountFor, chunkGridFor, WORLD_GAME, WORLD_SANDBOX } from "../../shared/protocol.ts";
import { wasmBytes } from "./helpers.ts";

describe("the protocol's chunk grid matches the sim", () => {
  for (const [name, kind, seed] of [["sandbox", WORLD_SANDBOX, 1n], ["game", WORLD_GAME, 5n]] as const) {
    it(`${name}: grid, count and chunk size agree with the real wasm`, () => {
      const sim = loadSim(wasmBytes);
      sim.init(seed, kind);
      const { cw, ch } = chunkGridFor(kind);
      expect(sim.chunkHashes().length).toBe(chunkCountFor(kind));
      expect(cw * ch).toBe(chunkCountFor(kind));
      expect(sim.width() / cw).toBe(sim.height() / ch); // square chunks
      expect(sim.width() % cw).toBe(0);
    });
  }
});
