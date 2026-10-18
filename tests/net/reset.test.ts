// Slice 5: the admin reset (D-097) over the real server with real WebSocket clients running the real sim.
// The test client helper does not model reconnect, so "reconnects on its own" is a fresh connect() after the 4001 close;
// the client's own onclose path (client/worker.ts) reconnects on any code except 4000 and is checked by reading it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { simInputBytes, decodeServer } from "../../shared/protocol.ts";
import { loadSim } from "../../shared/sim.ts";
import { GameDb } from "../../server/db.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { GAME_SEED, SANDBOX_SEED } from "../../server/world.ts";
import type { World } from "../../server/world.ts";
import { buildHashHex, connect, paintFor, register, sleep, waitFor, wasmBytes, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-reset-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const TOKEN = "test-admin-token";
async function boot(dir: string | null, extra: Parameters<typeof startServer>[0] = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks: 120, quiet: true, adminToken: TOKEN, ...extra });
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;
const reset = (s: RunningServer, world: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(`http://127.0.0.1:${s.port}/api/admin/reset`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ world }) });
const closeCode = (c: TestClient) => new Promise<number>((ok) => c.ws.once("close", (code) => ok(code)));

/** A fresh sim fed the server's current log: the state any correct client must reach. */
function replayLog(w: World, seed: bigint, kind: number) {
  // The log only holds ticks after the latest verified snapshot; replaying it from a fresh world is valid only
  // while no snapshot has been taken. A snapshot landing mid-test used to make this compare the wrong ticks.
  if (w.logBase !== 0 || w.snapshot) throw new Error(`replayLog needs the full log, but it starts after tick ${w.logBase}`);
  const sim = loadSim(wasmBytes);
  sim.init(seed, kind);
  const at = new Map<number, bigint>();
  for (const f of w.log) {
    const m = decodeServer(f);
    if (!m || m.t !== "tick") throw new Error("log holds a non-tick frame");
    for (const i of m.inputs) sim.pushInput(simInputBytes(i));
    sim.step();
    at.set(sim.tick(), sim.stateHash());
  }
  return { sim, at };
}
const solidCells = (c: TestClient) => c.ls.sim.matView().reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);

describe("World.reset", () => {
  it("sandbox: both clients get 4001, rejoin at tick 0 with the pre-reset paint gone, and agree again", async () => {
    // No snapshots in this test: the reference replay below needs the whole post-reset log from tick 1.
    const s = await boot(tmp(), { snapshotEveryTicks: 1_000_000 });
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    await paintFor([a, b], 1200);
    await waitFor(() => a.hashes.size >= 3 && b.hashes.size >= 3, 10000, "hashes");
    const shared = [...a.hashes.keys()].filter((t) => b.hashes.has(t));
    for (const t of shared) expect(b.hashes.get(t)).toBe(a.hashes.get(t));
    a.drain();
    const paintedCells = solidCells(a);
    const oldTick = s.world.clock.lastClosed;
    expect(oldTick).toBeGreaterThan(30);
    const oldIds = [a.playerId, b.playerId];

    const closes = Promise.all([closeCode(a), closeCode(b)]);
    const res = await reset(s, 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; world: number; oldTick: number };
    expect(body).toMatchObject({ ok: true, world: 0 });
    expect(body.oldTick).toBeGreaterThanOrEqual(oldTick);
    expect(await closes).toEqual([4001, 4001]);
    expect(s.world.clock.lastClosed).toBe(0);
    expect(s.world.log.length).toBe(0);
    expect(s.world.snapshot).toBeNull();
    const ev = s.log.recent().filter((e) => e.ev === "world.reset");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ world: 0, members: 2, old_tick: body.oldTick });
    // No Leaves were stamped into the new log, and the leave summaries still ran.
    await waitFor(() => s.log.recent().filter((e) => e.ev === "leave" && e.code === 4001).length === 2, 3000, "leave events");
    expect(s.world.log.length).toBe(0);

    // Reconnect (as the client does after any close but 4000).
    const c = await connect(s.port, hex);
    const d = await connect(s.port, hex);
    expect(c.playerId).not.toBe(oldIds[0]); // sandbox ids never repeat across a reset
    expect(oldIds).not.toContain(d.playerId);
    // Before anyone paints, the world is the generated one: no more solid cells than a fresh sim.
    c.drain();
    expect(c.ls.simTick).toBeLessThan(oldTick);
    const fresh = loadSim(wasmBytes);
    fresh.init(SANDBOX_SEED, 0);
    const freshCells = fresh.matView().reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
    expect(solidCells(c)).toBe(freshCells);
    expect(paintedCells).toBeGreaterThan(freshCells);
    await paintFor([c, d], 1200);
    await waitFor(() => c.hashes.size >= 3 && d.hashes.size >= 3, 10000, "hashes after reset");
    await sleep(200);
    c.drain();
    d.drain();
    // Agreement: the two clients match each other, and match a reference sim fed only the post-reset log.
    const ref = replayLog(s.world, SANDBOX_SEED, 0);
    const common = [...c.hashes.keys()].filter((t) => d.hashes.has(t) && ref.at.has(t));
    expect(common.length).toBeGreaterThan(3);
    for (const t of common) {
      expect(d.hashes.get(t), `tick ${t}`).toBe(c.hashes.get(t));
      expect(ref.at.get(t), `tick ${t} vs reference`).toBe(c.hashes.get(t));
    }
    expect(s.world.stats.hashFails).toBe(0);
    c.close();
    d.close();
  });

  it("persists: after a restart the world is the post-reset one, with no old snapshot or log", async () => {
    const dir = tmp();
    const s1 = await boot(dir);
    const a = await connect(s1.port, hex);
    const b = await connect(s1.port, hex);
    await paintFor([a, b], 1500);
    await waitFor(() => s1.world.stats.snapshotsAccepted >= 1, 20000, "a verified snapshot");
    expect(s1.db!.snapshotTicks(0).length).toBeGreaterThan(0);
    const closes = Promise.all([closeCode(a), closeCode(b)]);
    expect((await reset(s1, 0)).status).toBe(200);
    await closes;
    expect(s1.db!.snapshotTicks(0)).toEqual([]);
    expect(s1.db!.getWorld(0)!.lastTick).toBe(0);
    await s1.close();

    const s2 = await boot(dir);
    expect(s2.world.snapshot).toBeNull();
    expect(s2.world.clock.lastClosed).toBe(0);
    expect(s2.world.log.length).toBe(0);
    const c = await connect(s2.port, hex);
    await waitFor(() => s2.world.clock.lastClosed >= 10, 3000, "ticks");
    expect(s2.world.clock.lastClosed).toBeLessThan(600); // numbering restarted, not continued from the old world
    expect(c.counts.snapshots).toBe(0);
    c.close();
  });

  it("game world: player_stats and the players row survive; the player rejoins at the spawn point", async () => {
    const dir = tmp();
    const s = await boot(dir);
    const me = await register(s.port, "Survivor");
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    await waitFor(() => { a.drain(); return a.ls.simTick >= 5; }, 5000, "joined");
    const spawn = a.ls.sim.entities().find((e) => e.type === 1 && e.id === me.id)!;
    a.move(spawn.x / 16 + 3, spawn.y / 16 - 2);
    a.cast(0, 1000, 1);
    await waitFor(() => { a.drain(); const e = a.ls.sim.entities().find((x) => x.type === 1 && x.id === me.id); return !!e && e.x !== spawn.x; }, 5000, "moved");
    s.playerStats.flush();
    const statsBefore = s.playerStats.get(me.id);
    expect(Object.keys(statsBefore).length).toBeGreaterThan(0);
    const playersBefore = s.db!.playerCount();

    const closed = closeCode(a);
    expect((await reset(s, GAME)).status).toBe(200);
    expect(await closed).toBe(4001);
    expect(s.playerStats.get(me.id)).toMatchObject(statsBefore);
    expect(s.db!.loadStats(me.id)).toMatchObject(statsBefore);
    expect(s.db!.playerCount()).toBe(playersBefore);
    expect(s.identity.resolve(me.token, true)).toMatchObject({ id: me.id, name: "Survivor" });

    const b = await connect(s.port, hex, { world: GAME, token: me.token });
    expect(b.playerId).toBe(me.id);
    await waitFor(() => { b.drain(); return b.ls.simTick >= 5; }, 5000, "rejoined");
    const ref = replayLog(s.game, GAME_SEED, 1);
    b.drain();
    const e = b.ls.sim.entities().find((x) => x.type === 1 && x.id === me.id)!;
    expect(e.x).toBe(spawn.x); // same generated spawn as the first time, not where the player had walked
    expect(e.y).toBe(spawn.y);
    expect(b.ls.sim.stateHash()).toBe(ref.at.get(b.ls.simTick));
    // Stats keep counting after a reset.
    b.cast(0, 500, 1);
    await waitFor(() => (s.playerStats.get(me.id).sessions ?? 0) > (statsBefore.sessions ?? 0), 3000, "a new session counted");
    b.close();
  });

  it("the other world is unaffected", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Bystander");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    const p = await connect(s.port, hex);
    await sleep(300);
    const gTick = s.game.clock.lastClosed;
    const gLog = s.game.log.length;
    let gClosed = false;
    g.ws.once("close", () => (gClosed = true));
    const closed = closeCode(p);
    expect((await reset(s, 0)).status).toBe(200);
    await closed;
    await sleep(300);
    expect(gClosed).toBe(false);
    expect(s.game.clock.lastClosed).toBeGreaterThan(gTick);
    expect(s.game.log.length).toBeGreaterThan(gLog);
    expect(s.game.members.size).toBe(1);
    g.close();
  });

  it("an in-flight verification across a reset does not save the old snapshot", async () => {
    const s = await boot(tmp());
    // A delay hook: hold the verifier's answer until the test releases it, so the reset lands in between.
    const real = s.verifier!.hashOf.bind(s.verifier!);
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    let held = 0;
    s.verifier!.hashOf = async (...args) => {
      held++;
      const v = await real(...args); // a good answer: without the guard, every check after this would pass
      await gate;
      return v;
    };
    let saves = 0;
    const realSave = s.db!.saveSnapshot.bind(s.db!);
    s.db!.saveSnapshot = (...args) => {
      saves++;
      realSave(...args);
    };
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    await paintFor([a, b], 600);
    await waitFor(() => held >= 1 && s.world.verifying, 20000, "a verification in flight");
    const closes = Promise.all([closeCode(a), closeCode(b)]);
    expect((await reset(s, 0)).status).toBe(200);
    await closes;
    release();
    await sleep(300);
    expect(saves).toBe(0);
    expect(s.world.snapshot).toBeNull();
    expect(s.world.stats.snapshotsAccepted).toBe(0);
    expect(s.db!.snapshotTicks(0)).toEqual([]);
    expect(s.world.verifying).toBe(false);
  });
});

describe("POST /api/admin/reset", () => {
  it("403 with no token, a wrong token, a token in the wrong scheme, and when no ADMIN_TOKEN is configured", async () => {
    const s = await boot(tmp());
    expect((await reset(s, 0, {})).status).toBe(403);
    expect((await reset(s, 0, { authorization: "Bearer wrong" })).status).toBe(403);
    expect((await reset(s, 0, { authorization: `Basic ${TOKEN}` })).status).toBe(403);
    // A token in the query string is refused on this POST: header only.
    expect((await fetch(`http://127.0.0.1:${s.port}/api/admin/reset?token=${TOKEN}`, { method: "POST", body: JSON.stringify({ world: 0 }) })).status).toBe(403);
    // Refusals from one address are rate-limited, so a loop of POSTs can't flood the event ring.
    for (let i = 0; i < 20; i++) await reset(s, 0, { authorization: "Bearer wrong" });
    expect(s.log.recent().filter((e) => e.ev === "admin.refused").length).toBe(1);
    expect(s.log.recent().some((e) => e.ev === "world.reset")).toBe(false);
    const open = await boot(tmp(), { adminToken: "" });
    expect((await reset(open, 0, { authorization: "Bearer " })).status).toBe(403);
    expect((await reset(open, 0, { authorization: "Bearer undefined" })).status).toBe(403);
    expect(open.log.recent().some((e) => e.ev === "world.reset")).toBe(false);
  });

  it("400 for an unknown world or a bad body, and 405 for GET", async () => {
    const s = await boot(tmp());
    expect((await reset(s, 7)).status).toBe(400);
    expect((await reset(s, "0")).status).toBe(400);
    expect((await reset(s, undefined)).status).toBe(400);
    const bad = await fetch(`http://127.0.0.1:${s.port}/api/admin/reset`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/admin/reset`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });

  it("413 for a body over 1 KB", async () => {
    const s = await boot(tmp());
    const r = await fetch(`http://127.0.0.1:${s.port}/api/admin/reset`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ world: 0, pad: "x".repeat(2000) }) }).catch(() => null);
    expect(r === null || r.status === 413).toBe(true);
    expect(s.log.recent().some((e) => e.ev === "world.reset")).toBe(false);
  });

  it("refuses a cross-origin POST even with the right token, and allows the same origin", async () => {
    const s = await boot(tmp());
    const cross = await reset(s, 0, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect(s.log.recent().some((e) => e.ev === "admin.refused" && e.reason === "origin")).toBe(true);
    expect(s.log.recent().some((e) => e.ev === "world.reset")).toBe(false);
    const same = await reset(s, 0, { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${s.port}` });
    expect(same.status).toBe(200);
  });

  it("ticks/s reads the post-reset rate, not one skewed by pre-reset samples", async () => {
    const s = await boot(tmp());
    const a = await connect(s.port, hex);
    await waitFor(() => s.world.clock.lastClosed > 200, 10000, "ticks");
    await sleep(1100); // let the 1 s sampler record pre-reset tick numbers
    expect((await reset(s, 0)).status).toBe(200);
    const c = await connect(s.port, hex);
    // Without clearing the samples on reset this read about 7, 13, 17 (pre-reset ticks in the window).
    await sleep(1800);
    expect(s.summary().worlds.find((w) => w.world === 0)!.ticksPerSec).toBeGreaterThan(40);
    a.close();
    c.close();
  });

  it("an admin-tagged world.reset is logged with who asked", async () => {
    const s = await boot(tmp());
    await reset(s, 1);
    const e = s.log.recent().find((x) => x.ev === "world.reset")!;
    expect(String(e.by)).toMatch(/^admin@/);
    expect(e.lvl).toBe("warn");
  });
});
