// HM live: GET /api/rooms carries a live players count and sorts busiest first; the preview route is a plain
// HTTP read of the latest snapshot and never makes the viewer a member of the world.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../server/main.ts";
import { CAVES_PVP, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect, register, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

describe("menu: live room counts", () => {
  it("lists players per room, busiest first, and the preview route does not join the world", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-menu-live-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = await startServer({ port: 0, dataDir: dir, quiet: true });
    cleanups.push(() => s.close());
    const base = `http://127.0.0.1:${s.port}`;
    const make = async (name: string) =>
      (await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ name, mode: "deathmatch", config: Buffer.from(encodeConfig({ ...CAVES_PVP, size: 0 })).toString("base64"), visibility: "public" }) })).json()) as { id: number; code: string };
    const quiet = await make("Quiet"); // created first, so older
    const busy = await make("Busy");
    const empty = await make("Empty"); // newest, so first on last_active alone
    const who = await register(s.port, "Counter");
    const c = await connect(s.port, hex, { world: busy.id, token: who.token });
    cleanups.push(() => c.close());
    await waitFor(() => s.worlds.get(busy.id)!.members.size === 1, 10000, "member");
    const list = async () => ((await (await fetch(`${base}/api/rooms`)).json()) as { rooms: { code: string; players: number }[] }).rooms;
    const rows = await list();
    expect(rows[0]).toMatchObject({ code: busy.code, players: 1 });
    expect(rows.find((r) => r.code === quiet.code)!.players).toBe(0);
    expect(rows.find((r) => r.code === empty.code)!.players).toBe(0);
    // A preview read is not a connection: members and the count are unchanged, and an unsnapshotted room is 404.
    const p = await fetch(`${base}/api/rooms/${busy.code}/preview`);
    expect([200, 404]).toContain(p.status);
    expect(s.worlds.get(busy.id)!.members.size).toBe(1);
    expect((await list())[0].players).toBe(1);
  });
});
