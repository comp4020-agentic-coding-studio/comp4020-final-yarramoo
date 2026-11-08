// Review 8 Nov, M3: a room's `maxPlayers` is enforced at HELLO. Players beyond it are refused with a reason the room
// page shows; spectators still get in, and a player already in can reload (its new tab replaces the old one).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../server/main.ts";
import { CAVES_PVP, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect, register, sleep, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

describe("M3: maxPlayers is enforced at join", () => {
  it("a 2-player deathmatch room refuses a third player, admits a spectator, and lets a player reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-maxplayers-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = await startServer({ port: 0, dataDir: dir, quiet: true });
    cleanups.push(() => s.close());
    const config = Buffer.from(encodeConfig({ ...CAVES_PVP, size: 0, maxPlayers: 2 })).toString("base64");
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Duel", mode: "deathmatch", config, visibility: "public" }) });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    const [a, b, c] = await Promise.all(["Ann", "Bo", "Cy"].map((n) => register(s.port, n)));
    const open: TestClient[] = [];
    cleanups.push(() => open.forEach((x) => x.close()));
    open.push(await connect(s.port, hex, { world: id, token: a.token }));
    open.push(await connect(s.port, hex, { world: id, token: b.token }));
    await expect(connect(s.port, hex, { world: id, token: c.token })).rejects.toThrow(/room is full/);
    open.push(await connect(s.port, hex, { world: id, spectate: true }));
    // Ann reloads: the room is at its cap, but her new tab replaces her old one.
    open.push(await connect(s.port, hex, { world: id, token: a.token }));
    await sleep(100);
    expect(s.worlds.get(id)!.avatarPlayers).toBe(2);
  }, 30000);
});
