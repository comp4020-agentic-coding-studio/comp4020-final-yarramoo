// D5 and D7 on the M5 script: snapshots cut mid-flight, mid-death and with bags present restore and continue
// identically, and chunk sleeping stays invisible when bombs go off beside players.
import { describe, expect, it } from "vitest";
import { unhex } from "../../shared/inputs.ts";
import { ENT_BAG, ENT_PROJECTILE, EV_DEATH, EV_RESPAWN, loadSim } from "../../shared/sim.ts";
import { compare } from "./compare.ts";
import { m5Script, readWasm, wasmPath } from "./helpers.ts";
import { run } from "./run.ts";

const wasm = readWasm(wasmPath);
const { script } = m5Script();

function stepTo(sim: ReturnType<typeof loadSim>, from: number, to: number, log?: [number, string][]) {
  for (let t = from; t <= to; t++) {
    for (const hx of script.inputs[String(t)] ?? []) sim.pushInput(unhex(hx));
    sim.step();
    if (log && t % 30 === 0) log.push([t, sim.stateHash().toString(16)]);
  }
}

describe("D5 with the M5 script", () => {
  it("snapshot cuts (bomb in flight, mid-death, bags present, after respawn) restore and continue identically", () => {
    const full = loadSim(wasm);
    full.init(BigInt(script.seed), 1);
    const want: [number, string][] = [];
    const seen = { bag: [] as number[], proj: [] as number[], dead: [] as number[] };
    for (let t = 1; t <= script.ticks; t++) {
      stepTo(full, t, t);
      if (t % 30 === 0) want.push([t, full.stateHash().toString(16)]);
      const ents = full.entities();
      if (ents.some((e) => e.type === ENT_BAG && e.active)) seen.bag.push(t);
      if (ents.some((e) => e.type === ENT_PROJECTILE && e.sub === 5)) seen.proj.push(t);
    }
    // Cuts chosen from the script's own timeline (see the coverage test): bombs fly 40..100 and again after 135.
    // F3: the pickup table moved the Fire and Bomb spots, so bombs now fly at 70-75, 139-144, 204-214, 269-284.
    const cuts = [45, 72, 90, 101, 141, 150, 206, 240, 262, 300, 500, 899];
    expect(seen.bag.length).toBeGreaterThan(100);
    expect(seen.proj.length).toBeGreaterThan(50);
    expect(cuts.some((c) => seen.bag.includes(c)) && cuts.some((c) => seen.proj.includes(c))).toBe(true);
    for (const cut of cuts) {
      const a = loadSim(wasm);
      a.init(BigInt(script.seed), 1);
      stepTo(a, 1, cut);
      const snap = a.snapshot();
      const b = loadSim(wasm);
      b.restore(snap);
      expect(b.stateHash(), `cut ${cut}`).toBe(a.stateHash());
      const got: [number, string][] = [];
      stepTo(b, cut + 1, script.ticks, got);
      expect(got, `cut ${cut}`).toEqual(want.filter(([t]) => t > cut));
    }
  });

  it("the cuts include a tick with a dead player and a tick with a bomb in flight", () => {
    const sim = loadSim(wasm);
    sim.init(BigInt(script.seed), 1);
    const dead = new Set<number>();
    const marks: Record<number, { dead: number; bags: number; bombs: number }> = {};
    for (let t = 1; t <= 300; t++) {
      stepTo(sim, t, t);
      for (const e of sim.events()) {
        if (e.kind === EV_DEATH) dead.add(e.player);
        if (e.kind === EV_RESPAWN) dead.delete(e.player);
      }
      const ents = sim.entities();
      marks[t] = {
        dead: dead.size,
        bags: ents.filter((e) => e.type === ENT_BAG && e.active).length,
        bombs: ents.filter((e) => e.type === ENT_PROJECTILE && e.sub === 5).length,
      };
    }
    expect(marks[90].dead).toBeGreaterThan(0);
    expect(marks[72].bombs).toBeGreaterThan(0);
    // F3: the script's deaths moved (see the cuts above), so look across the run rather than at one tick.
    expect(Object.values(marks).some((m) => m.dead > 0 && m.bags > 0)).toBe(true);
  });
});

describe("D7 with the M5 script", () => {
  it("sleeping on and off agree at every checkpoint (bombs, gunpowder chains, players and bags)", () => {
    const on = run(wasm, script, {}, { sleep: true });
    const off = run(wasm, script, {}, { sleep: false });
    expect(on.hashes).toHaveLength(script.ticks / 60);
    expect(compare(on, off, ["sleep on", "sleep off"])).toBeNull();
  });
});
