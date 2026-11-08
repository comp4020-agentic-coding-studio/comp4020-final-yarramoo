import { describe, expect, it } from "vitest";
import { activePlayersIn } from "../../server/world.ts";
import { encodeCast, encodeJoin, encodeLeave, encodePos } from "../../shared/inputs.ts";
import { compressSnapshot, maxSnapshotRawFor } from "../../shared/protocol.ts";
import { CAVES_PVP } from "../../shared/room.ts";
import { snapshotLayout } from "../../shared/sim.ts";
import { ENT_BAG, ENT_PICKUP, ENT_PLAYER, ENT_PROJECTILE, EV_DEATH, EV_PICKUP, loadSim } from "../../shared/sim.ts";
import { wasmBytes } from "./helpers.ts";

// server/world.ts reads active player ids straight out of a snapshot's entity bytes, at offsets the sim build reports
// (`snapshotLayout`, review M4). This pins the parser, with those offsets, to what the real sim writes.
const layout = snapshotLayout(wasmBytes);
const CAP = maxSnapshotRawFor(CAVES_PVP);
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
    expect(activePlayersIn(compressSnapshot(sim.snapshot()), layout, CAP)).toEqual(truth);
  });

  // The entity section is players, pickups, projectiles, bags, each behind a u32 count (sim/src/entities.rs). The
  // server reads only the player section, which must stay first; this pins where the bag section begins, using a
  // real sim that has a dead player and a bag, so a reordering shows up here and not in production.
  it("sections are ordered players, pickups, projectiles, bags, enemies, heals, round bytes, with the bag a dead player dropped", () => {
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
    const HEADER = layout.headerBytes;
    const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
    const elen = dv.getUint32(HEADER, true);
    const e = new DataView(snap.buffer, snap.byteOffset + HEADER + 4, elen);
    const [PLAYER, PICKUP, PROJECTILE, BAG] = [layout.playerRecordBytes, 13, 23, 2 + 2 + 2 * 12 + 4];
    let o = 0;
    const np = e.getUint32(o, true);
    o += 4 + np * PLAYER;
    const nk = e.getUint32(o, true);
    o += 4 + nk * PICKUP;
    const nj = e.getUint32(o, true);
    o += 4 + nj * PROJECTILE;
    const nb = e.getUint32(o, true);
    const bagAt = o + 4;
    o += 4 + nb * BAG;
    // F4: an enemies section (u32 count, ENEMY_BYTES 40 each) then the round tail (over, running, boss_killed, result, lobby_since u32) closes the block.
    const ENEMY = 40;
    const ne = e.getUint32(o, true);
    o += 4 + ne * ENEMY;
    // Brief E: a heals section (u32 count, HEAL_BYTES 9 each) follows the enemies, before the round tail.
    const nh = e.getUint32(o, true);
    o += 4 + nh * 9 + 12;
    expect([np, nj, nb, ne, nh]).toEqual([1, 0, 1, 0, 0]); // a non-Survival world has no enemies or heals
    expect(nk).toBeGreaterThan(0);
    expect(o).toBe(elen);
    // The bag is the one the view reports: x, y are its cell, then the charges (just the pickup's grant).
    expect(e.getUint16(bagAt, true)).toBe(Math.floor((bags[0].x - 8) / 16));
    expect(bags[0].a).toBeGreaterThan(0);
  });

  it("an empty game world has no active players", () => {
    const sim = loadSim(wasmBytes);
    sim.init(5n, 1);
    sim.step();
    expect(activePlayersIn(compressSnapshot(sim.snapshot()), layout, CAP).size).toBe(0);
  });
});
