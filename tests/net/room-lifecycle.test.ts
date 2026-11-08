// N1: a room dies when nobody has been in it for a while (2 min after the last member, 10 min if never joined),
// judged by stored times so a restart does not kill a fresh room. Clocks are injected; no real 2-minute sleeps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { CLASSIC_SANDBOX, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-room-life-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const MIN = 60_000;
async function boot(dir: string, extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, roomSweepMs: 3_600_000, ...extra });
  cleanups.push(() => s.close());
  return s;
}
async function createRoom(port: number): Promise<{ id: number; code: string }> {
  const config = Buffer.from(encodeConfig(CLASSIC_SANDBOX)).toString("base64");
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Life", mode: "sandbox", config, visibility: "public" }) });
  expect(res.status).toBe(201);
  return await res.json();
}
const status = async (port: number, code: string) => (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}`)).status;
function rowsFor(dir: string, id: number): { room: number; snaps: number; ticks: number } {
  const d = new DatabaseSync(join(dir, "game.db"));
  try {
    const n = (sql: string) => Number((d.prepare(sql).get(id) as { n: number }).n);
    return { room: n("select count(*) n from rooms where id = ?"), snaps: n("select count(*) n from snapshots where world_id = ?"), ticks: n("select count(*) n from tick_log where world_id = ?") };
  } finally {
    d.close();
  }
}
const lastActive = (dir: string, id: number): number => {
  const d = new DatabaseSync(join(dir, "game.db"));
  try {
    return Number((d.prepare("select last_active a from rooms where id = ?").get(id) as { a: number }).a);
  } finally {
    d.close();
  }
};

describe("room lifecycle (N1)", () => {
  it("an empty played room is deleted after the grace period: 404, off the list, no rows left", async () => {
    const dir = tmp();
    const s = await boot(dir, { roomUnloadMs: 200 });
    const r = await createRoom(s.port);
    const a = await connect(s.port, hex, { world: r.id });
    await new Promise((ok) => setTimeout(ok, 300)); // let some ticks close so the tick log has rows
    a.close();
    await waitFor(() => !s.worlds.has(r.id), 3000, "room gone from memory");
    expect(await status(s.port, r.code)).toBe(404);
    const list = (await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`)).json()) as unknown;
    expect(JSON.stringify(list)).not.toContain(r.code);
    expect(rowsFor(dir, r.id)).toEqual({ room: 0, snaps: 0, ticks: 0 });
  });

  it("a member rejoining inside the grace period keeps the room", async () => {
    const dir = tmp();
    const s = await boot(dir, { roomUnloadMs: 400 });
    const r = await createRoom(s.port);
    const a = await connect(s.port, hex, { world: r.id });
    a.close();
    await new Promise((ok) => setTimeout(ok, 100));
    const b = await connect(s.port, hex, { world: r.id });
    await new Promise((ok) => setTimeout(ok, 600));
    expect(await status(s.port, r.code)).toBe(200);
    expect(s.worlds.has(r.id)).toBe(true);
    b.close();
  });

  it("a never-joined room survives 9 minutes and is gone after 10", async () => {
    let t = 1_000_000;
    const dir = tmp();
    const s = await boot(dir, { now: () => t });
    const r = await createRoom(s.port);
    t += 9 * MIN;
    expect(s.sweepRooms()).toEqual([]);
    expect(await status(s.port, r.code)).toBe(200);
    t += 1 * MIN + 1;
    expect(s.sweepRooms()).toEqual([r.id]);
    expect(await status(s.port, r.code)).toBe(404);
    expect(rowsFor(dir, r.id).room).toBe(0);
  });

  it("last_active follows the clock while occupied, and a spectator alone keeps the room alive", async () => {
    let t = 5_000_000;
    const dir = tmp();
    const s = await boot(dir, { now: () => t });
    const r = await createRoom(s.port);
    const sp = await connect(s.port, hex, { world: r.id, spectate: true });
    t += 30 * MIN; // far past both grace periods, but someone is watching
    expect(s.sweepRooms()).toEqual([]);
    expect(lastActive(dir, r.id)).toBe(t);
    expect(await status(s.port, r.code)).toBe(200);
    sp.close();
    await waitFor(() => s.worlds.get(r.id)!.playerCount === 0, 3000, "spectator left");
    expect(lastActive(dir, r.id)).toBe(t); // the leave stamped it
    t += 2 * MIN + 1;
    expect(s.sweepRooms()).toEqual([r.id]);
    expect(await status(s.port, r.code)).toBe(404);
  });

  it("restart: a room made just before survives; a room idle past the grace period is gone", async () => {
    let t = 9_000_000;
    const dir = tmp();
    const s1 = await boot(dir, { now: () => t });
    const fresh = await createRoom(s1.port);
    const old = await createRoom(s1.port);
    const never = await createRoom(s1.port);
    const c = await connect(s1.port, hex, { world: old.id });
    c.close();
    await waitFor(() => lastActive(dir, old.id) >= t, 3000, "stamped");
    await s1.close();
    t += 3 * MIN; // restart 3 minutes later: old was last active 3 min ago, fresh/never were created 3 min ago
    const s2 = await boot(dir, { now: () => t });
    expect(await status(s2.port, fresh.code)).toBe(200);
    expect(await status(s2.port, never.code)).toBe(200);
    expect(await status(s2.port, old.code)).toBe(404);
    t += 8 * MIN; // 11 minutes after creation, never joined
    expect(s2.sweepRooms().sort()).toEqual([fresh.id, never.id].sort());
  });

  it("the fixed worlds never die", async () => {
    let t = 1_000;
    const dir = tmp();
    const s = await boot(dir, { now: () => t });
    t += 1000 * MIN;
    s.sweepRooms();
    expect(s.worlds.has(0)).toBe(true);
    expect(s.worlds.has(1)).toBe(true);
    const a = await connect(s.port, hex, { world: 0 });
    a.close();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(s.worlds.has(0)).toBe(true);
  });

  it("a HELLO for a room that was just deleted is refused as unknown, not resurrected", async () => {
    let t = 1_000;
    const dir = tmp();
    const s = await boot(dir, { now: () => t });
    const r = await createRoom(s.port);
    t += 11 * MIN;
    s.sweepRooms();
    await expect(connect(s.port, hex, { world: r.id })).rejects.toThrow(/unknown room/);
    expect(s.worlds.has(r.id)).toBe(false);
    expect(rowsFor(dir, r.id).room).toBe(0);
  });
});
