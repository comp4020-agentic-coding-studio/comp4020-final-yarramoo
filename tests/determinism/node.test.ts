import { describe, expect, it } from "vitest";
import { compare } from "./compare.ts";
import { m5Missing } from "./m5-coverage.ts";
import { castScript, m5Script, survivalScript, tiersScript, readWasm, sharedScript, wasmPath } from "./helpers.ts";
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

  // The M5 script: pickups, bombs, Fire bolts, damage, deaths, bags, respawn.
  const m5 = m5Script().script;
  it("M5 coverage: the script really collects, explodes, kills, respawns and returns to a bag", () => {
    const r = run(wasm, m5, {}, { collectEvents: true });
    expect(m5Missing(r.events!)).toEqual([]);
  });

  it("M5 coverage assertion fails on the old game script (no pickups, no deaths)", () => {
    const old = run(wasm, cast, {}, { collectEvents: true });
    const missing = m5Missing(old.events!);
    expect(missing).toContain("EV_DEATH with a bag (c=1)");
    expect(missing).toContain("EV_PICKUP of Bomb (5)");
    expect(missing).toContain("EV_RESPAWN");
  });

  it("D1 with M5: two fresh instances agree", () => {
    expect(compare(run(wasm, m5), run(readWasm(wasmPath), m5), ["run1", "run2"])).toBeNull();
  });

  it("D6 with M5: 1 step per call, 7 per call and a catch-up burst agree", () => {
    const one = run(wasm, m5, {}, { batching: { kind: "each" } });
    const seven = run(wasm, m5, {}, { batching: { kind: "batch", k: 7 } });
    const burst = run(wasm, m5, {}, { batching: { kind: "burst", at: 60, len: 500 } });
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

  // F4: a Survival world with slimes, hit and hitting back. D1 (two instances) and D6 (batching) agree, and the
  // script really hurt and killed slimes (so the enemy code ran, not just generation).
  const surv = survivalScript().script;
  it("D1/D6 with slimes: instances and batchings agree, and slimes were hurt", () => {
    const a = run(readWasm(wasmPath), surv, {}, { collectEvents: true });
    const b = run(readWasm(wasmPath), surv);
    const seven = run(readWasm(wasmPath), surv, {}, { batching: { kind: "batch", k: 7 } });
    expect(compare(a, b, ["run1", "run2"])).toBeNull();
    expect(compare(a, seven, ["each", "k=7"])).toBeNull();
    expect(a.events!.filter((e) => e.kind === 11).length).toBeGreaterThanOrEqual(3);
  });

  // F5: an imp fires at a player and a worm tunnels to another. D1/D6 agree, an enemy-owned bolt (owner high bit)
  // impacted, and the worm reached its player (a contact knock, which needs the tunnel: the player is inside rock).
  const tiers = tiersScript().script;
  it("D1/D6 with imps and worms: agree, an imp bolt flew and a worm dug to its player", () => {
    const a = run(readWasm(wasmPath), tiers, {}, { collectEvents: true });
    const b = run(readWasm(wasmPath), tiers);
    const seven = run(readWasm(wasmPath), tiers, {}, { batching: { kind: "batch", k: 7 } });
    expect(compare(a, b, ["run1", "run2"])).toBeNull();
    expect(compare(a, seven, ["each", "k=7"])).toBeNull();
    expect(a.events!.some((e) => e.kind === 6 && e.player >= 0x80000000)).toBe(true);
    expect(a.events!.some((e) => e.kind === 5 && e.player === 2 && e.b === -24)).toBe(true);
  });
});
