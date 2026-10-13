import { describe, expect, it } from "vitest";
import { activePlayersIn } from "../../server/world.ts";
import { encodeCast, encodeJoin, encodeLeave } from "../../shared/inputs.ts";
import { compressSnapshot } from "../../shared/protocol.ts";
import { ENT_PLAYER, ENT_PROJECTILE, loadSim } from "../../shared/sim.ts";
import { wasmBytes } from "./helpers.ts";

// server/world.ts reads active player ids straight out of a snapshot's entity bytes, at offsets
// copied from the Rust layout (sim/src/entities.rs). If that layout changes, the server must not
// quietly start reading garbage: this pins the parser to what the real sim writes.
describe("server's snapshot entity parser matches the sim", () => {
  it("reads exactly the players the sim reports active", () => {
    const sim = loadSim(wasmBytes);
    sim.init(5n, 1);
    for (const id of [3, 9, 27, 81]) sim.pushInput(encodeJoin(id));
    sim.step();
    sim.pushInput(encodeLeave(9));
    sim.step();
    sim.step();
    // Bolts in flight (Push from one player, Water from another with charges via a pickup is not needed: Push twice
    // from two players) put the appended projectile section into the snapshot the parser reads.
    sim.pushInput(encodeCast(3, 0, 0, 1));
    sim.pushInput(encodeCast(27, 0, 32768, 1));
    sim.step();
    expect(sim.entities().filter((e) => e.type === ENT_PROJECTILE).length).toBeGreaterThan(0);
    const truth = new Set(sim.entities().filter((e) => e.type === ENT_PLAYER && e.active).map((e) => e.id));
    expect([...truth].sort((a, b) => a - b)).toEqual([3, 27, 81]);
    expect(activePlayersIn(compressSnapshot(sim.snapshot()))).toEqual(truth);
  });

  it("an empty game world has no active players", () => {
    const sim = loadSim(wasmBytes);
    sim.init(5n, 1);
    sim.step();
    expect(activePlayersIn(compressSnapshot(sim.snapshot())).size).toBe(0);
  });
});
