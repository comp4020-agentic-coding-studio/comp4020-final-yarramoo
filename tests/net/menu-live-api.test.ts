// Menu W1: GET /api/live carries live player counts and a public death log (plain names, public rooms only).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLiveFeed, type LiveDeath } from "../../server/live.ts";
import { startServer } from "../../server/main.ts";
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

interface Live { players: number; rooms: number; deaths: (LiveDeath & { self: boolean })[] }

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "sand-menu-live-api-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, inputSummaryMs: 100000 });
  cleanups.push(() => s.close());
  const base = `http://127.0.0.1:${s.port}`;
  const make = async (visibility: "public" | "unlisted", mode = "deathmatch") =>
    (await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Live", mode, config: Buffer.from(encodeConfig({ ...CAVES_PVP, size: 0 })).toString("base64"), visibility }) })).json()) as { id: number };
  const live = async (): Promise<Live> => (await fetch(`${base}/api/live`)).json() as Promise<Live>;
  return { s, base, make, live };
}

/** Two players in a room; Bo dies to Ana (cause 44) by majority claim. */
async function killBoIn(env: Awaited<ReturnType<typeof boot>>, roomId: number) {
  const ana = await register(env.s.port, "Ana");
  const bo = await register(env.s.port, "Bo");
  const a = await connect(env.s.port, hex, { world: roomId, token: ana.token });
  const b = await connect(env.s.port, hex, { world: roomId, token: bo.token });
  cleanups.push(() => a.close());
  cleanups.push(() => b.close());
  await sleep(400);
  const tick = env.s.worlds.get(roomId)!.clock.lastClosed - 1;
  a.ws.send(encodeClaim(tick, bo.id, ana.id, 44, 0));
  b.ws.send(encodeClaim(tick, bo.id, ana.id, 44, 0));
  await waitFor(() => env.s.playerStats.get(bo.id).deaths === 1, 5000, "death resolved");
}

describe("GET /api/live", () => {
  it("counts a player in a public room, not one in an unlisted room", async () => {
    const env = await boot();
    const pub = await env.make("public");
    const unl = await env.make("unlisted");
    const p = await register(env.s.port, "Pub");
    const u = await register(env.s.port, "Unl");
    const c1 = await connect(env.s.port, hex, { world: pub.id, token: p.token });
    const c2 = await connect(env.s.port, hex, { world: unl.id, token: u.token });
    cleanups.push(() => c1.close());
    cleanups.push(() => c2.close());
    await waitFor(() => env.s.worlds.get(pub.id)!.members.size === 1 && env.s.worlds.get(unl.id)!.members.size === 1, 10000, "members");
    const r = await fetch(`${env.base}/api/live`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ players: 1, rooms: 1, gameRooms: { live: 2, max: 2 }, deaths: [] });
    expect((await fetch(`${env.base}/api/live`, { method: "POST" })).status).toBe(405);
  }, 30000);

  it("a death in a public room appears with plain names, cause and mode", async () => {
    const env = await boot();
    const room = await env.make("public");
    await killBoIn(env, room.id);
    const l = await env.live();
    expect(l.deaths).toHaveLength(1);
    expect(l.deaths[0]).toMatchObject({ victim: "Bo", killer: "Ana", self: false, cause: 44, bag: false, mode: "deathmatch" });
    expect(JSON.stringify(l)).not.toContain("#");
    expect(typeof l.deaths[0].at).toBe("number");
  }, 30000);

  it("a death in an unlisted room never appears", async () => {
    const env = await boot();
    const room = await env.make("unlisted");
    await killBoIn(env, room.id);
    expect((await env.live()).deaths).toEqual([]);
  }, 30000);
});

describe("live feed (pure)", () => {
  const death = (n: number): LiveDeath => ({ victim: `V${n}`, killer: null, self: false, cause: n, bag: false, mode: "survival", at: n });
  it("keeps the newest 20, newest first", () => {
    const f = createLiveFeed({ now: () => 0 });
    for (let i = 0; i < 25; i++) f.recordDeath(death(i));
    const out = JSON.parse(f.json(() => ({ players: 0, rooms: 0, gameRooms: { live: 0, max: 2 } }))) as Live;
    expect(out.deaths).toHaveLength(20);
    expect(out.deaths[0].cause).toBe(24);
    expect(out.deaths[19].cause).toBe(5);
  });
  it("computes at most once per 2 s, and a death invalidates", () => {
    let t = 1000;
    let calls = 0;
    const f = createLiveFeed({ now: () => t });
    const count = () => ({ players: ++calls, rooms: 0, gameRooms: { live: 0, max: 2 } });
    expect((JSON.parse(f.json(count)) as Live).players).toBe(1);
    t += 1999;
    expect((JSON.parse(f.json(count)) as Live).players).toBe(1);
    t += 1;
    expect((JSON.parse(f.json(count)) as Live).players).toBe(2);
    f.recordDeath(death(1));
    expect((JSON.parse(f.json(count)) as Live).players).toBe(3);
  });
});
