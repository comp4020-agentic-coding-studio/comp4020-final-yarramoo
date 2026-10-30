import { describe, expect, it } from "vitest";
import { activePlayersIn } from "../../server/world.ts";
import { encodeCast, encodeJoin, encodeLeave, encodePos } from "../../shared/inputs.ts";
import { compressSnapshot } from "../../shared/protocol.ts";
import { ENT_BAG, ENT_PICKUP, ENT_PLAYER, ENT_PROJECTILE, EV_DEATH, EV_PICKUP, loadSim } from "../../shared/sim.ts";
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

  // The entity section is players, pickups, projectiles, bags, each behind a u32 count (sim/src/entities.rs). The
  // server reads only the player section, which must stay first; this pins where the bag section begins, using a
  // real sim that has a dead player and a bag, so a reordering shows up here and not in production.
  it("sections are ordered players, pickups, projectiles, bags, with the bag a dead player dropped", () => {
    const sim = loadSim(wasmBytes);
    sim.init(5n, 1);
    sim.pushInput(encodeJoin(3));
    sim.step();
    // Walk onto a pickup (Pos at its feet anchor), then into lava until dead.
    const pickup = sim.entities().find((e) => e.type === ENT_PICKUP)!;
    const life = sim.entities().find((e) => e.type === ENT_PLAYER)!.a;
    sim.pushInput(encodePos(3, life, pickup.x, pickup.y, 0));
    sim.step();
    expect(sim.events().some((e) => e.kind === EV_PICKUP)).toBe(true);
    const mat = sim.matView();
    const w = sim.width();
    const at = mat.indexOf(14); // LAVA
    expect(at).toBeGreaterThanOrEqual(0);
    sim.pushInput(encodePos(3, life, (at % w) * 16 + 8, (Math.floor(at / w) + 1) * 16, 0));
    let death = null;
    for (let t = 0; t < 400 && !death; t++) {
      sim.step();
      death = sim.events().find((e) => e.kind === EV_DEATH) ?? null;
    }
    expect(death).not.toBeNull();
    expect(death!.c).toBe(1); // a bag dropped
    const bags = sim.entities().filter((e) => e.type === ENT_BAG);
    expect(bags.length).toBe(1);

    const snap = sim.snapshot();
    const HEADER = 70;
    const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
    const elen = dv.getUint32(HEADER, true);
    const e = new DataView(snap.buffer, snap.byteOffset + HEADER + 4, elen);
    const [PLAYER, PICKUP, PROJECTILE, BAG] = [71, 13, 23, 16];
    let o = 0;
    const np = e.getUint32(o, true);
    o += 4 + np * PLAYER;
    const nk = e.getUint32(o, true);
    o += 4 + nk * PICKUP;
    const nj = e.getUint32(o, true);
    o += 4 + nj * PROJECTILE;
    const nb = e.getUint32(o, true);
    expect([np, nj, nb]).toEqual([1, 0, 1]);
    expect(nk).toBeGreaterThan(0);
    expect(o + 4 + nb * BAG).toBe(elen);
    // The bag is the one the view reports: x, y are its cell, then the charges (just the pickup's grant).
    expect(e.getUint16(o + 4, true)).toBe(Math.floor((bags[0].x - 8) / 16));
    expect(bags[0].a).toBeGreaterThan(0);
  });

  it("an empty game world has no active players", () => {
    const sim = loadSim(wasmBytes);
    sim.init(5n, 1);
    sim.step();
    expect(activePlayersIn(compressSnapshot(sim.snapshot())).size).toBe(0);
  });
});
