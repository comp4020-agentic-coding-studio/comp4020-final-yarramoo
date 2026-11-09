// D-237 (9 Nov): two Survival/Deathmatch rooms at once on the course VM, the menu told how many are live, and an empty
// game room deleted 10 s after its last member leaves. Sandboxes (plain or owned) and the fixed worlds are outside the cap.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, MAX_LOADED_GAME_ROOMS, type RunningServer } from "../../server/main.ts";
import { CAVES_PVP, CLASSIC_SANDBOX, SURVIVAL, encodeConfig, type RoomConfig } from "../../shared/room.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function boot(extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "sand-game-cap-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, roomSweepMs: 3_600_000, maxMembersSoft: 100, maxMembersHard: 100, ...extra });
  cleanups.push(() => s.close());
  return s;
}
const DM: RoomConfig = { ...CAVES_PVP, size: 0 };
async function create(port: number, mode: string, cfg: RoomConfig): Promise<Response> {
  const config = Buffer.from(encodeConfig(cfg)).toString("base64");
  return fetch(`http://127.0.0.1:${port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Cap", mode, config, visibility: "public" }) });
}
async function room(port: number, mode: string, cfg: RoomConfig): Promise<{ id: number; code: string }> {
  const r = await create(port, mode, cfg);
  expect(r.status).toBe(201);
  return (await r.json()) as { id: number; code: string };
}
const live = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/live`)).json()) as { players: number; rooms: number; gameRooms: { live: number; max: number } };
const status = async (port: number, code: string) => (await fetch(`http://127.0.0.1:${port}/api/rooms/${code}`)).status;

describe("the game-room cap", () => {
  it("is two", () => {
    expect(MAX_LOADED_GAME_ROOMS).toBe(2);
  });

  it("refuses a third game room while two run; sandboxes do not count; /api/live reports it", async () => {
    const s = await boot();
    const sb1 = await room(s.port, "sandbox", CLASSIC_SANDBOX);
    const sb2 = await room(s.port, "sandbox", CLASSIC_SANDBOX);
    for (const id of [sb1.id, sb2.id]) cleanups.push((await connect(s.port, hex, { world: id })).close);
    expect((await live(s.port)).gameRooms).toEqual({ live: 0, max: 2 });
    const a = await room(s.port, "deathmatch", DM);
    const b = await room(s.port, "survival", SURVIVAL);
    const c = await room(s.port, "deathmatch", DM); // created while one slot was free; its join finds none
    cleanups.push((await connect(s.port, hex, { world: a.id, spectate: true })).close);
    cleanups.push((await connect(s.port, hex, { world: b.id, spectate: true })).close);
    await expect(connect(s.port, hex, { world: c.id, spectate: true })).rejects.toThrow(/server busy/);
    expect(s.worlds.has(c.id)).toBe(false);
    // Creating one now is refused at once, so the menu can say so; a sandbox is still made and still loads.
    const full = await create(s.port, "survival", SURVIVAL);
    expect(full.status).toBe(503);
    expect(((await full.json()) as { error: string }).error).toBe("rooms_full");
    const sb3 = await room(s.port, "sandbox", CLASSIC_SANDBOX);
    cleanups.push((await connect(s.port, hex, { world: sb3.id })).close);
    await sleep(2100); // past the /api/live cache
    expect((await live(s.port)).gameRooms).toEqual({ live: 2, max: 2 });
  });
});

describe("empty game rooms", () => {
  it("an emptied Survival room is deleted after 10 s; an owned sandbox emptied with it is not", async () => {
    let t = 1_000_000;
    const s = await boot({ now: () => t });
    const me = await register(s.port, "Keeper");
    const owned = (await (await fetch(`http://127.0.0.1:${s.port}/api/sandbox`, { method: "POST", headers: { authorization: `Bearer ${Buffer.from(me.token).toString("hex")}` } })).json()) as { id: number; code: string };
    const surv = await room(s.port, "survival", SURVIVAL);
    for (const id of [owned.id, surv.id]) {
      const c = await connect(s.port, hex, { world: id, spectate: true });
      c.close();
      await waitFor(() => s.worlds.get(id)!.playerCount === 0, 3000, "left");
    }
    const left = performance.now();
    await sleep(7000);
    expect(s.worlds.has(surv.id)).toBe(true); // not before 10 s
    await waitFor(() => !s.worlds.has(surv.id), 6000, "survival room deleted");
    expect(performance.now() - left).toBeGreaterThan(9500);
    expect(await status(s.port, surv.code)).toBe(404);
    expect(await status(s.port, owned.code)).toBe(200);
    t += 30 * 24 * 3_600_000;
    expect(s.sweepRooms()).toEqual([]);
    expect(await status(s.port, owned.code)).toBe(200);
  });

  it("a never-joined game room goes after a minute; a never-joined sandbox room keeps its 10 minutes", async () => {
    let t = 1_000_000;
    const s = await boot({ now: () => t });
    const g = await room(s.port, "deathmatch", DM);
    const sb = await room(s.port, "sandbox", CLASSIC_SANDBOX);
    t += 30_000;
    expect(s.sweepRooms()).toEqual([]);
    t += 31_000;
    expect(s.sweepRooms()).toEqual([g.id]);
    expect(await status(s.port, sb.code)).toBe(200);
  });

  it("a restart does not delete a running game room before its players can reconnect; the next sweep does if none do", async () => {
    let t = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "sand-game-cap-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const opts = { port: 0, dataDir: dir, quiet: true, roomSweepMs: 3_600_000, now: () => t };
    const s1 = await startServer(opts);
    const g = await room(s1.port, "survival", SURVIVAL);
    const c = await connect(s1.port, hex, { world: g.id, spectate: true });
    await sleep(200);
    await s1.close(); // a deploy: members dropped, last_active stamped
    c.close();
    t += 40_000; // the machine takes 40 s to come back
    const s2 = await startServer(opts);
    cleanups.push(() => s2.close());
    expect(await status(s2.port, g.code)).toBe(200); // the boot sweep kept it
    expect(s2.sweepRooms()).toEqual([g.id]); // nobody came back by the next periodic sweep
  });
});
