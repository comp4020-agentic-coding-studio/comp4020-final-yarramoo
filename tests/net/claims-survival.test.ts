// F7: the real-sim claim path over the real server. Two Node clients (running the real sim, sending the same claims
// client/worker.ts sends, built from the events their sim emits) in one Survival room: the server must resolve
// round.start, an enemy kill and round.end, and the ended room must leave the public list.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { ENT_ENEMY, ENT_PICKUP, ENT_PLAYER, ENT_ROUND } from "../../shared/sim.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const FIRE_BOLT = 4;

describe("Survival claims from real sim clients", () => {
  it("round start, an enemy kill and a lost round resolve, and the ended room leaves the public list", async () => {
    const d = mkdtempSync(join(tmpdir(), "sand-f7-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    // A fixed seed: the scripted kill below needs the same world every run (D-219; room seeds are random since D-201).
    const s: RunningServer = await startServer({ port: 0, dataDir: d, snapshotEveryTicks: 120, quiet: true, roomSeed: 2n });
    cleanups.push(() => s.close());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Descent", mode: "survival", config: Buffer.from(encodeConfig({ ...SURVIVAL, size: 0 })).toString("base64"), visibility: "public" }),
    });
    const room = (await res.json()) as { id: number; code: string };
    const listed = async () => ((await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`)).json()) as { rooms: { code: string }[] }).rooms.map((r) => r.code);
    expect(await listed()).toContain(room.code);

    const [ra, rb] = [await register(s.port, "Ada"), await register(s.port, "Bo")];
    const a = await connect(s.port, hex, { world: room.id, token: ra.token });
    const b = await connect(s.port, hex, { world: room.id, token: rb.token });
    await waitFor(() => [a, b].every((c) => c.ls.sim.entities().filter((e) => e.type === ENT_PLAYER && e.active).length === 2), 8000, "both joined");
    a.ready(1);
    b.ready(1);
    const running = () => (a.ls.sim.entities().find((e) => e.type === ENT_ROUND)?.health ?? 0) & 1;
    await waitFor(() => !!running(), 10000, "round started");
    await waitFor(() => s.log.recent().some((e) => e.ev === "round.start"), 5000, "round.start resolved");
    expect(s.worlds.get(room.id)!.roundRunning).toBe(true);

    // Kill an enemy: take a Fire bolt pickup, then stand near the nearest enemy and shoot it. Positions are 1/16 cell.
    const sim = a.ls.sim;
    const enemies = () => sim.entities().filter((e) => e.type === ENT_ENEMY);
    const pick = sim.entities().filter((e) => e.type === ENT_PICKUP && e.sub === FIRE_BOLT && e.active)[0];
    expect(pick).toBeDefined();
    let seq = 1;
    const myXY = (id: number) => sim.entities().find((e) => e.type === ENT_PLAYER && e.id === id)!;
    // D-219: every wait below counts A's sim ticks, never milliseconds. The server's clock is wall time, so when a loaded
    // gate starves this process a `sleep(90)` walk step could cover 60+ ticks: A then spent ten times the sim time among
    // the enemies, followed its slime into the depths and died before the first cast (hp 0, then 39 casts from a corpse).
    // Paced by ticks, the walk and the casts take the same sim time however slow the host is.
    const ticks = (n: number) => {
      const t0 = sim.tick();
      return waitFor(() => sim.tick() >= t0 + n, 60_000, `${n} sim ticks`);
    };
    // The server bounds a Pos jump by the server ticks since the last one, plus 10 ticks of slack, at 9 cells per tick
    // (shared/avatar.ts maxPosJump). Each step covers WALK_CELLS_PER_TICK per server tick since the last step (at most
    // WALK_MAX_STEP), so A crosses the map in the same sim time whether this process wakes every tick or once a second.
    // One step per WALK_EVERY ticks keeps under the input rate limit. The sim takes the avatar's Pos as given.
    const serverTick = () => s.worlds.get(room.id)!.clock.lastClosed;
    const WALK_EVERY = 3;
    const WALK_CELLS_PER_TICK = 6;
    const WALK_MAX_STEP = 300;
    const pos = { x: 0, y: 0 };
    let lastStep = serverTick();
    const walk = async (x: number, y: number) => {
      while (Math.hypot(x - pos.x, y - pos.y) > 0.01) {
        await waitFor(() => serverTick() >= lastStep + WALK_EVERY, 60_000, "a server tick to walk on");
        const now = serverTick();
        const d = Math.hypot(x - pos.x, y - pos.y);
        const k = Math.min(1, Math.min(WALK_MAX_STEP, WALK_CELLS_PER_TICK * (now - lastStep)) / d);
        lastStep = now;
        pos.x += (x - pos.x) * k;
        pos.y += (y - pos.y) * k;
        a.move(pos.x, pos.y, 0, myXY(ra.id).a); // the sim drops a Pos with a stale life; the round start bumped it
      }
    };
    const me0 = myXY(ra.id);
    pos.x = me0.x / 16;
    pos.y = me0.y / 16;
    await walk(pick.x / 16, pick.y / 16);
    await ticks(24);
    const slimes = () => enemies().filter((e) => e.sub === 0);
    const nearest = () => {
      const me = myXY(ra.id);
      return slimes().sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y))[0];
    };
    const slain = () => s.log.recent().some((e) => e.ev === "achievement.awarded" && e.achievement === "slime_slayer");
    for (let i = 0; i < 40 && !slain(); i++) {
      // A dead caster can never land the kill: say so, rather than time out on the majority wait below.
      if (myXY(ra.id).health === 0) throw new Error(`A died before killing a slime (tick ${sim.tick()}, try ${i})`);
      const t = nearest(); // a slime that died to something else is replaced by the next nearest
      expect(t).toBeDefined();
      await walk((t.x - 6 * 16) / 16, t.y / 16);
      await ticks(6);
      const me = myXY(ra.id);
      const t2 = slimes().find((e) => e.id === t.id);
      if (!t2) continue;
      // Aim where the slime is now, not where it was before the walk (it moves while A walks).
      const ang = Math.round((((Math.atan2(t2.y - 4 * 16 - (me.y - 6 * 16), t2.x - me.x) / (2 * Math.PI)) % 1) + 1) % 1 * 65536) & 0xffff;
      a.cast(FIRE_BOLT, ang, seq++);
      await ticks(18);
    }
    await waitFor(() => (s.playerStats.get(ra.id).enemy_kills ?? 0) >= 1, 5000, "enemy kill resolved by majority");
    // The award reaches A's socket after the server resolves it: wait for it rather than read it in the same turn (D-219).
    await waitFor(() => a.achievements.some((x) => x.id === "slime_slayer"), 10_000, "slime_slayer delivered to A");
    expect(b.achievements.map((x) => x.id)).not.toContain("slime_slayer");

    // End the round by a loss: both players walk into enemies and the lava below until everyone is dead.
    const walkB = { x: 0, y: 0 };
    const me1 = myXY(rb.id);
    walkB.x = me1.x / 16;
    walkB.y = me1.y / 16;
    const dive = async (c: typeof a, st: { x: number; y: number }, id: number, dy: number) => {
      const me = myXY(id);
      if (me.health === 0) return;
      const nearest = enemies().sort((p, q) => Math.hypot(p.x / 16 - st.x, p.y / 16 - st.y) - Math.hypot(q.x / 16 - st.x, q.y / 16 - st.y))[0];
      const tx = nearest ? nearest.x / 16 : st.x;
      const ty = nearest ? nearest.y / 16 : st.y + dy;
      const d = Math.hypot(tx - st.x, ty - st.y) || 1;
      const k = Math.min(1, 40 / d);
      st.x += (tx - st.x) * k;
      st.y += (ty - st.y) * k;
      c.move(st.x, st.y, 0, me.a);
    };
    const stA = { x: myXY(ra.id).x / 16, y: myXY(ra.id).y / 16 };
    const stopAt = performance.now() + 60000;
    while (!s.log.recent().some((e) => e.ev === "round.end") && performance.now() < stopAt) {
      await dive(a, stA, ra.id, 30);
      await dive(b, walkB, rb.id, 30);
      await sleep(90);
    }
    await waitFor(() => s.log.recent().some((e) => e.ev === "round.end"), 5000, "round.end resolved");
    expect(s.log.recent().find((e) => e.ev === "round.end")).toMatchObject({ result: "loss", players: 2, alive: 0 });
    expect(s.worlds.get(room.id)!.roundEnded).toBe(true);
    expect(await listed()).not.toContain(room.code);
    const info = (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms/${room.code}`)).json()) as { ended: boolean; running: boolean };
    expect(info).toMatchObject({ ended: true, running: false });
  }, 120000);
});

describe("F7 aggregates", () => {
  it("summary reports round state per room and the kill aggregate is one line per room, not per kill", async () => {
    const d = mkdtempSync(join(tmpdir(), "sand-f7b-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const s = await startServer({ port: 0, dataDir: d, quiet: true, inputSummaryMs: 150 });
    cleanups.push(() => s.close());
    const w = s.game;
    expect(s.summary().worlds.find((x) => x.world === w.id)!.round).toBeNull(); // Deathmatch: no round
    const killer = await register(s.port, "Ana");
    const c = await connect(s.port, hex, { world: 1, token: killer.token });
    await sleep(300);
    s.game.onKillResolved!({ tick: 1, killer: killer.id, x: 1, y: 1, kind: 0 });
    s.game.onKillResolved!({ tick: 2, killer: killer.id, x: 2, y: 2, kind: 0 });
    s.game.onKillResolved!({ tick: 3, killer: killer.id, x: 3, y: 3, kind: 1 });
    await waitFor(() => s.log.recent().some((e) => e.ev === "enemy.kill"), 3000, "enemy.kill aggregate");
    const lines = s.log.recent().filter((e) => e.ev === "enemy.kill");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ world: 1, kills: 3, by_kind: "0:2,1:1" });
    c.close();
  }, 20000);
});

describe("lobby stat gating", () => {
  it("a Survival lobby credits no depth or casts until the start claim resolves; a round-less room is unaffected", async () => {
    const d = mkdtempSync(join(tmpdir(), "sand-f7c-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const s = await startServer({ port: 0, dataDir: d, quiet: true });
    cleanups.push(() => s.close());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Gate", mode: "survival", config: Buffer.from(encodeConfig({ ...SURVIVAL, size: 0 })).toString("base64"), visibility: "public" }),
    });
    const room = (await res.json()) as { id: number };
    const who = await register(s.port, "Gater");
    const c = await connect(s.port, hex, { world: room.id, token: who.token });
    await waitFor(() => c.ls.sim.entities().some((e) => e.type === ENT_PLAYER && e.active), 8000, "joined");
    const me = () => c.ls.sim.entities().find((e) => e.type === ENT_PLAYER && e.id === who.id)!;
    c.move(me().x / 16 + 1, me().y / 16 + 20, 0, me().a);
    c.cast(FIRE_BOLT, 0, 1);
    await sleep(500);
    expect(s.playerStats.get(who.id).max_depth ?? 0).toBe(0);
    expect(s.playerStats.get(who.id).casts_fire_bolt ?? 0).toBe(0);
    expect(s.worlds.get(room.id)!.creditsStats()).toBe(false);
    c.ready(1);
    await waitFor(() => s.worlds.get(room.id)!.roundRunning, 10000, "start claim resolved");
    c.move(me().x / 16 + 1, me().y / 16 + 20, 0, me().a);
    await waitFor(() => (s.playerStats.get(who.id).max_depth ?? 0) > 0, 3000, "depth credited after the start");
    // Deathmatch (no round) is never gated.
    expect(s.game.creditsStats()).toBe(true);
  }, 30000);
});

describe("restored and ended rooms (review S5, N1)", () => {
  it("an unloaded room with ticks reports running; after the round ends it reports ended, refuses players and accepts spectators", async () => {
    const d = mkdtempSync(join(tmpdir(), "sand-f7d-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const cfg = Buffer.from(encodeConfig({ ...SURVIVAL, size: 0 })).toString("base64");
    let s = await startServer({ port: 0, dataDir: d, quiet: true, snapshotEveryTicks: 120 });
    const room = (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Back", mode: "survival", config: cfg, visibility: "public" }) })).json()) as { id: number; code: string };
    const who = await register(s.port, "Back");
    const c = await connect(s.port, hex, { world: room.id, token: who.token });
    await waitFor(() => c.ls.sim.entities().some((e) => e.type === ENT_PLAYER && e.active), 8000, "joined");
    await sleep(500);
    c.close();
    await sleep(300);
    await s.close();
    // A fresh process: the room is not loaded, and its round state is not in memory.
    s = await startServer({ port: 0, dataDir: d, quiet: true });
    cleanups.push(() => s.close());
    expect(s.worlds.has(room.id)).toBe(false);
    const get = async () => (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms/${room.code}`)).json()) as { running: boolean; ended: boolean };
    expect(await get()).toMatchObject({ running: true, ended: false });
    // End it (as a resolved round-end claim would) and reload: ended comes from the row.
    s.db!.db.prepare("update rooms set ended_at = 1 where id = ?").run(room.id);
    expect(await get()).toMatchObject({ running: false, ended: true });
    const rejected = await new Promise<string>((ok) => {
      void connect(s.port, hex, { world: room.id, token: who.token }).then(() => ok("joined"), (e: Error) => ok(e.message));
    });
    expect(rejected).toContain("round is over");
    const spec = await connect(s.port, hex, { world: room.id, spectate: true });
    expect(s.worlds.get(room.id)!.roundEnded).toBe(true);
    spec.close();
  }, 40000);
});
