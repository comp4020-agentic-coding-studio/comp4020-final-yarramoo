// The chunk grid in shared/protocol.ts sets the CHUNK_HASHES frame cap and maps chunk indices to cells in a desync
// report. It is a copy of the sim's layout, so check it against the real wasm: chunkHashes() returns one hash per
// chunk, and width()/height() give the world, so a sim change to CHUNK or a world size fails here.
import { describe, expect, it } from "vitest";
import { loadSim } from "../../shared/sim.ts";
import { chunkCountFor, chunkGridFor } from "../../shared/protocol.ts";
import { CAVES_PVP, CLASSIC_SANDBOX, encodeConfig } from "../../shared/room.ts";
import { wasmBytes } from "./helpers.ts";

describe("the protocol's chunk grid matches the sim", () => {
  for (const [name, kind, seed] of [["sandbox", CLASSIC_SANDBOX, 1n], ["game", CAVES_PVP, 5n]] as const) {
    it(`${name}: grid, count and chunk size agree with the real wasm`, () => {
      const sim = loadSim(wasmBytes);
      sim.init(seed, encodeConfig(kind));
      const { cw, ch } = chunkGridFor(kind);
      expect(sim.chunkHashes().length).toBe(chunkCountFor(kind));
      expect(cw * ch).toBe(chunkCountFor(kind));
      expect(sim.width() / cw).toBe(sim.height() / ch); // square chunks
      expect(sim.width() % cw).toBe(0);
    });
  }
});
