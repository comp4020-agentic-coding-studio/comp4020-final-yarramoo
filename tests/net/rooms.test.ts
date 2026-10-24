// R2a: the rooms table and HTTP API, inert next to the two fixed worlds (no socket/protocol change).
// Red-first per the brief: this file is written against server/rooms.ts and the /api/rooms routes before
// they exist, so import errors / 404s are the expected starting failure.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { GameDb } from "../../server/db.ts";
import { RoomsStore } from "../../server/rooms.ts";
import { CLASSIC_SANDBOX, CAVES_PVP, encodeConfig } from "../../shared/room.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-rooms-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  cleanups.push(() => s.close());
  return s;
}

const cfgB64 = (c = CLASSIC_SANDBOX) => Buffer.from(encodeConfig(c)).toString("base64");

describe("server/rooms.ts: data access and validation", () => {
  it("creates a room, retrieves it by id and by code case-insensitively", () => {
    const db = new GameDb(tmp());
    const rooms = new RoomsStore(db);
    const r = rooms.createRoom({ name: "Hilltop", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: null });
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r) || !r.ok) throw new Error("expected ok");
    expect(r.room.code).toHaveLength(6);
    expect(rooms.getRoomById(r.room.id)?.code).toBe(r.room.code);
    expect(rooms.getRoomByCode(r.room.code.toLowerCase())?.id).toBe(r.room.id);
    expect(rooms.getRoomByCode(r.room.code.toUpperCase())?.id).toBe(r.room.id);
  });

  it("rejects a config that decodeConfig refuses, and never stores the bad row", () => {
    const db = new GameDb(tmp());
    const rooms = new RoomsStore(db);
    const bad = new Uint8Array(16); // all zero: version byte 0 != CONFIG_VERSION
    const r = rooms.createRoom({ name: "Bad", mode: "sandbox", config: bad, visibility: "public", creatorPlayerId: null });
    expect("ok" in r && r.ok).toBe(false);
    expect(rooms.listPublicRooms()).toHaveLength(0);
  });

  it("rejects an unknown mode", () => {
    const db = new GameDb(tmp());
    const rooms = new RoomsStore(db);
    const r = rooms.createRoom({ name: "X", mode: "nonsense", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: null });
    expect("ok" in r && r.ok).toBe(false);
  });

  it("caps the name at 32 code points and strips control characters", () => {
    const db = new GameDb(tmp());
    const rooms = new RoomsStore(db);
    const r = rooms.createRoom({ name: "x".repeat(80) + "\u0000", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: null });
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r) || !r.ok) throw new Error("expected ok");
    expect(r.room.name.length).toBeLessThanOrEqual(32);
    expect(r.room.name).not.toMatch(/\u0000/);
  });

  it("lists only public rooms, ordered by last_active descending", () => {
    const db = new GameDb(tmp());
    const rooms = new RoomsStore(db);
    const a = rooms.createRoom({ name: "A", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: null });
    rooms.createRoom({ name: "B", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "unlisted", creatorPlayerId: null });
    const c = rooms.createRoom({ name: "C", mode: "deathmatch", config: encodeConfig(CAVES_PVP), visibility: "public", creatorPlayerId: null });
    if (!("ok" in a) || !a.ok || !("ok" in c) || !c.ok) throw new Error("expected ok");
    const list = rooms.listPublicRooms();
    expect(list.map((r) => r.name)).toEqual(["C", "A"]); // C created after A, so more recently active
  });

  it("generates a different code on a collision instead of crashing", () => {
    const db = new GameDb(tmp());
    let calls = 0;
    const forcedCollision = () => {
      calls++;
      // First two calls collide on the same code, forcing a retry; after that, vary it.
      return calls <= 2 ? "AAAAAA" : `BBBBB${calls}`.slice(0, 6);
    };
    const rooms = new RoomsStore(db, { genCode: forcedCollision });
    const r1 = rooms.createRoom({ name: "One", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: null });
    const r2 = rooms.createRoom({ name: "Two", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: null });
    if (!("ok" in r1) || !r1.ok || !("ok" in r2) || !r2.ok) throw new Error("expected ok");
    expect(r1.room.code).not.toBe(r2.room.code);
  });

  it("rate limits room creation per creator per day", () => {
    const db = new GameDb(tmp());
    const rooms = new RoomsStore(db);
    const playerId = db.createPlayer("Creator", "deadbeef".repeat(8));
    for (let i = 0; i < 3; i++) {
      const r = rooms.createRoom({ name: `R${i}`, mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: playerId });
      expect("ok" in r && r.ok).toBe(true);
    }
    const r4 = rooms.createRoom({ name: "R4", mode: "sandbox", config: encodeConfig(CLASSIC_SANDBOX), visibility: "public", creatorPlayerId: playerId });
    expect("ok" in r4 && r4.ok).toBe(false);
  });
});

describe("HTTP API: POST/GET /api/rooms, GET /api/rooms/:code", () => {
  it("creates a room over POST and returns 201 with id/code/name/mode/visibility", async () => {
    const s = await boot(tmp());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Test Room", mode: "sandbox", config: cfgB64(), visibility: "public" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("number");
    expect(body.code).toHaveLength(6);
    expect(body.name).toBe("Test Room");
    expect(body.mode).toBe("sandbox");
    expect(body.visibility).toBe("public");
  });

  it("rejects a bad config with a 4xx, not a 500, and never stores the row", async () => {
    const s = await boot(tmp());
    const badConfig = Buffer.from(new Uint8Array(16)).toString("base64"); // version byte 0 is invalid
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", mode: "sandbox", config: badConfig, visibility: "public" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const list = await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`)).json();
    expect(list.rooms).toHaveLength(0);
  });

  it("rejects an oversized body", async () => {
    const s = await boot(tmp());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST", body: "x".repeat(20000) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("GET /api/rooms lists only public rooms, with no player names or live counts", async () => {
    const s = await boot(tmp());
    await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Public1", mode: "sandbox", config: cfgB64(), visibility: "public" }),
    });
    await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Hidden", mode: "sandbox", config: cfgB64(), visibility: "unlisted" }),
    });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]).toMatchObject({ name: "Public1", mode: "sandbox" });
    expect(body.rooms[0]).not.toHaveProperty("creator_player_id");
    expect(body.rooms[0]).not.toHaveProperty("config");
  });

  it("GET /api/rooms/:code returns the config and world id for joining, case-insensitively", async () => {
    const s = await boot(tmp());
    const created = await (
      await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
        method: "POST",
        body: JSON.stringify({ name: "Joinable", mode: "sandbox", config: cfgB64(), visibility: "public" }),
      })
    ).json();
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms/${created.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(typeof body.config).toBe("string");
  });

  it("404s an unknown room code", async () => {
    const s = await boot(tmp());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms/ZZZZZZ`);
    expect(res.status).toBe(404);
  });

  it("rejects cross-origin room creation the same way /api/players does", async () => {
    const s = await boot(tmp());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ name: "Evil", mode: "sandbox", config: cfgB64(), visibility: "public" }),
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("the existing two fixed worlds keep working untouched", async () => {
    const s = await boot(tmp());
    expect(s.world.id).toBeDefined();
    expect(s.game.id).toBeDefined();
    const summary = await (await fetch(`http://127.0.0.1:${s.port}/api/summary`)).json();
    expect(summary.worlds).toHaveLength(2);
  });
});
