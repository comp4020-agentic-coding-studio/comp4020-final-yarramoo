// F7 item 1: a death in a created room (not the fixed game world) reaches stats (review row 9).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { CAVES_PVP, encodeConfig } from "../../shared/room.ts";
import { encodeClaim } from "../../shared/protocol.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
export async function bootRooms(): Promise<RunningServer> {
  const d = mkdtempSync(join(tmpdir(), "sand-claim-rooms-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: d, quiet: true, inputSummaryMs: 100000 });
  cleanups.push(() => s.close());
  return s;
}
export async function makeRoom(port: number, cfg = { ...CAVES_PVP, size: 0 }, mode = "deathmatch"): Promise<{ id: number; code: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ name: "Claims", mode, config: Buffer.from(encodeConfig(cfg)).toString("base64"), visibility: "public" }),
  });
  return await res.json();
}

describe("deaths in a created room", () => {
  it("a majority death claim in a created room counts the death and the kill", async () => {
    const s = await bootRooms();
    const room = await makeRoom(s.port);
    const ana = await register(s.port, "Ana");
    const bo = await register(s.port, "Bo");
    const a = await connect(s.port, hex, { world: room.id, token: ana.token });
    const b = await connect(s.port, hex, { world: room.id, token: bo.token });
    await sleep(400);
    const tick = s.worlds.get(room.id)!.clock.lastClosed - 1;
    a.ws.send(encodeClaim(tick, bo.id, ana.id, 7, 0));
    b.ws.send(encodeClaim(tick, bo.id, ana.id, 7, 0));
    await waitFor(() => s.playerStats.get(bo.id).deaths === 1, 3000, "death counted in a created room");
    expect(s.playerStats.get(ana.id).kills).toBe(1);
    a.close();
    b.close();
  }, 30000);
});
