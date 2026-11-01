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
    const s: RunningServer = await startServer({ port: 0, dataDir: d, snapshotEveryTicks: 120, quiet: true });
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
    // The server bounds a Pos jump per tick, so walk in short steps (the sim takes the avatar's Pos as given).
    const pos = { x: 0, y: 0 };
    const walk = async (x: number, y: number) => {
      while (Math.hypot(x - pos.x, y - pos.y) > 0.01) {
        const d = Math.hypot(x - pos.x, y - pos.y);
        const k = Math.min(1, 40 / d);
        pos.x += (x - pos.x) * k;
        pos.y += (y - pos.y) * k;
        a.move(pos.x, pos.y, 0, myXY(ra.id).a); // the sim drops a Pos with a stale life; the round start bumped it
        await sleep(90);
      }
    };
    const me0 = myXY(ra.id);
    pos.x = me0.x / 16;
    pos.y = me0.y / 16;
    await walk(pick.x / 16, pick.y / 16);
    await sleep(400);
    const target = enemies().filter((e) => e.sub === 0).sort((p, q) => Math.hypot(p.x - pick.x, p.y - pick.y) - Math.hypot(q.x - pick.x, q.y - pick.y))[0];
    expect(target).toBeDefined();
    for (let i = 0; i < 40 && !s.log.recent().some((e) => e.ev === "achievement.awarded" && e.achievement === "slime_slayer"); i++) {
      const t = enemies().find((e) => e.id === target.id);
      if (!t) break;
      await walk((t.x - 6 * 16) / 16, t.y / 16);
      await sleep(100);
      const me = myXY(ra.id);
      const ang = Math.round((((Math.atan2(t.y - 4 * 16 - (me.y - 6 * 16), t.x - me.x) / (2 * Math.PI)) % 1) + 1) % 1 * 65536) & 0xffff;
      a.cast(FIRE_BOLT, ang, seq++);
      await sleep(300);
    }
    await waitFor(() => (s.playerStats.get(ra.id).enemy_kills ?? 0) >= 1, 5000, "enemy kill resolved by majority");
    expect(a.achievements.map((x) => x.id)).toContain("slime_slayer");
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
