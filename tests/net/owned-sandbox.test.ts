// OWNED (8 Nov): a player's own persistent sandbox. One per player, anyone with the link paints in it, only its owner
// deletes it, and it outlives the empty-room sweep and a restart. Survival/Deathmatch rooms stay ephemeral.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-owned-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const MIN = 60_000;
async function boot(dir: string, extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, roomSweepMs: 3_600_000, ...extra });
  cleanups.push(() => s.close());
  return s;
}
const hexOf = (t: Uint8Array) => Buffer.from(t).toString("hex");
const auth = (t: Uint8Array) => ({ authorization: `Bearer ${hexOf(t)}` });
type Owned = { id: number; code: string; name: string; mode: string; visibility: string; created?: boolean };
async function api(port: number, method: string, path: string, token?: Uint8Array): Promise<{ status: number; body: Owned & { error?: string } }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: token ? auth(token) : {} });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const status = async (port: number, code: string) => (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}`)).status;
function rowsFor(dir: string, id: number): { room: number; world: number; snaps: number; ticks: number } {
  const d = new DatabaseSync(join(dir, "game.db"));
  try {
    const n = (sql: string) => Number((d.prepare(sql).get(id) as { n: number }).n);
    return {
      room: n("select count(*) n from rooms where id = ?"),
      world: n("select count(*) n from worlds where id = ?"),
      snaps: n("select count(*) n from snapshots where world_id = ?"),
      ticks: n("select count(*) n from tick_log where world_id = ?"),
    };
  } finally {
    d.close();
  }
}

describe("owned sandbox", () => {
  it("one per player: a second create returns the same world; it is link-only and named for its owner", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Mitch");
    expect((await api(s.port, "GET", "/api/sandbox", me.token)).status).toBe(404);
    const a = await api(s.port, "POST", "/api/sandbox", me.token);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ mode: "sandbox", visibility: "unlisted", name: "Mitch's world", created: true });
    const b = await api(s.port, "POST", "/api/sandbox", me.token);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id: a.body.id, code: a.body.code, created: false });
    expect((await api(s.port, "GET", "/api/sandbox", me.token)).body.code).toBe(a.body.code);
    // Another player gets their own, and the public list shows neither.
    const other = await register(s.port, "Ann");
    const c = await api(s.port, "POST", "/api/sandbox", other.token);
    expect(c.status).toBe(201);
    expect(c.body.id).not.toBe(a.body.id);
    const list = JSON.stringify(await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`)).json());
    expect(list).not.toContain(a.body.code);
    expect(list).not.toContain(c.body.code);
    const pub = (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms/${a.body.code}`)).json()) as { owned: boolean };
    expect(pub.owned).toBe(true);
  });

  it("needs a known token: none, a malformed one and a stranger's are 401", async () => {
    const s = await boot(tmp());
    expect((await api(s.port, "POST", "/api/sandbox")).status).toBe(401);
    expect((await api(s.port, "POST", "/api/sandbox", new Uint8Array(32).fill(7))).status).toBe(401);
    const r = await fetch(`http://127.0.0.1:${s.port}/api/sandbox`, { method: "POST", headers: { authorization: "Bearer xyz" } });
    expect(r.status).toBe(401);
  });

  it("a non-owner can join and paint but not delete it (403); the owner can", async () => {
    const dir = tmp();
    const s = await boot(dir);
    const owner = await register(s.port, "Owner");
    const guest = await register(s.port, "Guest");
    const room = (await api(s.port, "POST", "/api/sandbox", owner.token)).body;
    const a = await connect(s.port, hex, { world: room.id, token: owner.token });
    const b = await connect(s.port, hex, { world: room.id, token: guest.token });
    b.paint(4, 100, 100, 140, 100, 6);
    await waitFor(() => s.worlds.get(room.id)!.clock.lastClosed > 20, 5000, "ticks");
    await sleep(300);
    a.drain();
    b.drain();
    const shared = [...a.hashes.keys()].filter((k) => b.hashes.has(k));
    expect(shared.length).toBeGreaterThan(0);
    for (const k of shared) expect(b.hashes.get(k), `tick ${k}`).toBe(a.hashes.get(k));
    const del = await api(s.port, "DELETE", `/api/sandbox/${room.code}`, guest.token);
    expect(del.status).toBe(403);
    expect(await status(s.port, room.code)).toBe(200);
    expect(rowsFor(dir, room.id).room).toBe(1);
    // An ordinary (unowned) room cannot be deleted through this route either.
    const config = Buffer.from(encodeConfig(SURVIVAL)).toString("base64");
    const plain = (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Plain", mode: "survival", config, visibility: "public" }) })).json()) as Owned;
    expect((await api(s.port, "DELETE", `/api/sandbox/${plain.code}`, owner.token)).status).toBe(403);
    // The owner deletes it with both members still in: they are closed, and everything stored for it is gone.
    const closed = new Promise<number>((ok) => a.ws.on("close", (code) => ok(code)));
    const ok = await api(s.port, "DELETE", `/api/sandbox/${room.code}`, owner.token);
    expect(ok.status).toBe(200);
    expect(await closed).toBe(4003);
    expect(s.worlds.has(room.id)).toBe(false);
    expect(await status(s.port, room.code)).toBe(404);
    expect(rowsFor(dir, room.id)).toEqual({ room: 0, world: 0, snaps: 0, ticks: 0 });
    expect((await api(s.port, "GET", "/api/sandbox", owner.token)).status).toBe(404);
    // A fresh one can be made afterwards, with a new code.
    const again = await api(s.port, "POST", "/api/sandbox", owner.token);
    expect(again.status).toBe(201);
    expect(again.body.code).not.toBe(room.code);
  });

  it("survives the sweep long past the grace periods, while an emptied Survival room is still swept", async () => {
    let t = 1_000_000;
    const dir = tmp();
    const s = await boot(dir, { now: () => t });
    const me = await register(s.port, "Keeper");
    const owned = (await api(s.port, "POST", "/api/sandbox", me.token)).body;
    const neverJoined = (await api(s.port, "POST", "/api/sandbox", (await register(s.port, "Idle")).token)).body;
    const config = Buffer.from(encodeConfig(SURVIVAL)).toString("base64");
    const surv = (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Surv", mode: "survival", config, visibility: "public" }) })).json()) as Owned;
    for (const id of [owned.id, surv.id]) {
      const c = await connect(s.port, hex, { world: id, spectate: true });
      c.close();
      await waitFor(() => s.worlds.get(id)!.playerCount === 0, 3000, "left");
    }
    t += 30 * 24 * 60 * MIN; // a month later
    expect(s.sweepRooms()).toEqual([surv.id]);
    expect(await status(s.port, owned.code)).toBe(200);
    expect(await status(s.port, neverJoined.code)).toBe(200);
    expect(await status(s.port, surv.code)).toBe(404);
  });

  it("unloads when empty (memory freed, rows kept) and reloads on the next join", async () => {
    const dir = tmp();
    const s = await boot(dir, { roomUnloadMs: 200 });
    const me = await register(s.port, "Loader");
    const room = (await api(s.port, "POST", "/api/sandbox", me.token)).body;
    const a = await connect(s.port, hex, { world: room.id, token: me.token });
    a.paint(5, 50, 50, 90, 50, 6);
    await waitFor(() => s.worlds.get(room.id)!.clock.lastClosed > 30, 5000, "ticks");
    a.close();
    await waitFor(() => !s.worlds.has(room.id), 3000, "unloaded");
    expect(rowsFor(dir, room.id).room).toBe(1);
    expect(rowsFor(dir, room.id).ticks).toBeGreaterThan(0);
    expect(await status(s.port, room.code)).toBe(200);
    const b = await connect(s.port, hex, { world: room.id, token: me.token });
    await waitFor(() => s.worlds.has(room.id) && s.worlds.get(room.id)!.playerCount === 1, 5000, "reloaded");
    b.close();
  });

  it("an owner who never joined a game world is not evicted, and nobody else is pinned (review N1)", async () => {
    let t = 1_000_000;
    const dir = tmp();
    const s = await boot(dir, { now: () => t });
    const owner = await register(s.port, "Keeper");
    const drifter = await register(s.port, "Drifter");
    expect((await api(s.port, "POST", "/api/sandbox", owner.token)).status).toBe(201);
    const d = new DatabaseSync(join(dir, "game.db"));
    try {
      expect(d.prepare("select joined_at j from players where id = ?").get(owner.id)).toEqual({ j: null });
    } finally {
      d.close();
    }
    // Both registrations are far past the eviction grace; only the one without a world goes.
    expect(s.db!.evictUnjoined(Date.now() + 60 * MIN)).toBe(1);
    expect((await api(s.port, "GET", "/api/sandbox", owner.token)).status).toBe(200);
    expect((await api(s.port, "GET", "/api/sandbox", drifter.token)).status).toBe(401);
  });

  it("the total number of owned worlds is capped (review N1)", async () => {
    const s = await boot(tmp(), { maxOwnedRooms: 2 });
    const tokens = [];
    for (const n of ["A", "B", "C"]) tokens.push((await register(s.port, n)).token);
    expect((await api(s.port, "POST", "/api/sandbox", tokens[0])).status).toBe(201);
    expect((await api(s.port, "POST", "/api/sandbox", tokens[1])).status).toBe(201);
    expect((await api(s.port, "POST", "/api/sandbox", tokens[2])).status).toBe(503);
    // An owner asking again still gets theirs at the cap.
    expect((await api(s.port, "POST", "/api/sandbox", tokens[0])).status).toBe(200);
  });

  it("survives a restart with its painted cells: a fresh client after the restart reaches the same hash", async () => {
    const dir = tmp();
    const s1 = await boot(dir, { snapshotEveryTicks: 120 });
    const me = await register(s1.port, "Persist");
    const room = (await api(s1.port, "POST", "/api/sandbox", me.token)).body;
    const a = await connect(s1.port, hex, { world: room.id, token: me.token, manual: true });
    const stepper = setInterval(() => a.ls.run(100000), 5);
    cleanups.push(() => clearInterval(stepper));
    for (let i = 0; i < 20; i++) {
      a.paint(i % 2 ? 4 : 6, 80 + i * 10, 200, 90 + i * 10, 260, 6);
      await sleep(30);
    }
    await waitFor(() => (s1.worlds.get(room.id)?.stats.snapshotsAccepted ?? 0) >= 1, 20000, "a verified snapshot");
    await sleep(300);
    clearInterval(stepper);
    a.ls.run(100000);
    const stopTick = a.ls.simTick;
    const stopHash = a.ls.sim.stateHash();
    a.close();
    await sleep(200);
    await s1.close();

    // The restart is a day later: boot's own sweep runs past every grace period and must keep the owned room.
    const s2 = await boot(dir, { now: () => Date.now() + 24 * 60 * MIN });
    expect(s2.worlds.has(room.id)).toBe(false); // lazy: nothing loaded until someone opens the link
    expect((await api(s2.port, "GET", "/api/sandbox", me.token)).body.code).toBe(room.code);
    const guest = await register(s2.port, "Visitor");
    const c = await connect(s2.port, hex, { world: room.id, token: guest.token, manual: true });
    await waitFor(() => c.counts.snapshots === 1, 5000, "snapshot");
    const w = s2.worlds.get(room.id)!;
    await waitFor(() => c.ls.latestClosed >= stopTick, 5000, "log tail");
    while (c.ls.simTick < stopTick && c.ls.stepOne());
    expect(c.ls.simTick).toBe(stopTick);
    expect(c.ls.sim.stateHash()).toBe(stopHash);
    expect(w.clock.lastClosed).toBeGreaterThanOrEqual(stopTick);
    c.close();
  }, 60_000);
});
