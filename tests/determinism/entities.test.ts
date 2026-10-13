// The typed entity and event decoders in shared/sim.ts read what the wasm writes.
import { describe, expect, it } from "vitest";
import { encodeJoin, encodePos } from "../../shared/inputs.ts";
import { ENT_PICKUP, ENT_PLAYER, EV_PICKUP, EV_SPAWN, loadSim } from "../../shared/sim.ts";
import { readWasm, wasmPath } from "./helpers.ts";

describe("entities() and events() over the ABI", () => {
  it("decodes a spawn, a player, the pickups, and a collection", () => {
    const sim = loadSim(readWasm(wasmPath));
    sim.init(2n, 1);
    sim.pushInput(encodeJoin(5));
    sim.step();
    expect(sim.events().map((e) => [e.kind, e.player])).toEqual([[EV_SPAWN, 5]]);
    const ents = sim.entities();
    const players = ents.filter((e) => e.type === ENT_PLAYER);
    const pickups = ents.filter((e) => e.type === ENT_PICKUP);
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ id: 5, active: true, health: 100, a: 0 });
    expect(pickups.length).toBeGreaterThanOrEqual(48);
    expect(pickups.every((p) => p.active && p.sub >= 2 && p.sub <= 5)).toBe(true);
    const k = pickups[0];
    // Stand on it: Pos is 1/16 cell, feet at the pickup cell's bottom edge.
    sim.pushInput(encodePos(5, 0, k.x, k.y, 0));
    sim.step();
    const ev = sim.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: EV_PICKUP, player: 5, a: k.id, b: k.sub });
    expect(sim.entities().find((e) => e.type === ENT_PICKUP && e.id === k.id)?.active).toBe(false);
    sim.step();
    expect(sim.events()).toEqual([]);
  });
});
