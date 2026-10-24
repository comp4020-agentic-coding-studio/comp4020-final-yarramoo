// R2b: protocol v9 (WELCOME carries the room's config), lazy room loading/unloading, admission caps, and the
// pre-existing acceptPos size bug. Red-first per the brief: the acceptPos test and the full join-flow test
// are written to fail against the pre-fix code (see each test's comment for what "red" looked like).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { GameDb } from "../../server/db.ts";
import { RoomsStore } from "../../server/rooms.ts";
import { World, SANDBOX_SEED } from "../../server/world.ts";
import { CLASSIC_SANDBOX, CAVES_PVP, encodeConfig, SIZE_DIMS, type RoomConfig } from "../../shared/room.ts";
import { POS_ONE } from "../../shared/avatar.ts";
import { encodeHello, PROTOCOL_VERSION, decodeServer } from "../../shared/protocol.ts";
import WebSocket from "ws";
import { buildHashHex, connect, register, sleep, waitFor, unhex } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-room-join-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string | null, extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, ...extra });
  cleanups.push(() => s.close());
  return s;
}

/** Create a room over the real R2a HTTP API and return its id + code, like a real client would. */
async function createRoom(port: number, opts: { mode?: string; cfg?: RoomConfig; visibility?: string; name?: string } = {}): Promise<{ id: number; code: string }> {
  const config = Buffer.from(encodeConfig(opts.cfg ?? CLASSIC_SANDBOX)).toString("base64");
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ name: opts.name ?? "Test Room", mode: opts.mode ?? "sandbox", config, visibility: opts.visibility ?? "public" }),
  });
  expect(res.status).toBe(201);
  return await res.json();
}

describe("acceptPos: the pre-existing size bug (brief item 5)", () => {
  // RED (before the fix): this test fails on the pre-fix code, which bounds every room against the fixed
  // GAME_W/GAME_H (2048x1536, L's size) regardless of the room's own cfg. Run against the old code:
  //   expected false to be true // a size-S room should have accepted an in-bounds Pos
  // (and conversely an out-of-L-bounds-but-impossible-for-S position was "accepted" because the check only
  // looked at the fixed constants). The fix reads SIZE_DIMS[this.cfg.size] instead.
  it("bounds a Pos against the room's own size (S), not the fixed L-sized GAME_W/GAME_H", () => {
    const w = new World({ id: 999001, cfg: { ...CLASSIC_SANDBOX, avatars: 1 }, seed: SANDBOX_SEED, now: () => 0 });
    const peer = { send: () => {}, buffered: () => 0, close: () => {} };
    const j = w.join(peer, { playerId: 1 });
    const [sw, sh] = SIZE_DIMS[0]; // S: 512x512
    expect(sw).toBe(512);
    // Payload layout: life u16, x i32, y i32, facing u8 (POS_PAYLOAD_LEN = 11).
    const payload = (x: number, y: number) => {
      const b = new Uint8Array(11);
      const v = new DataView(b.buffer);
      v.setUint16(0, 0, true);
      v.setInt32(2, x, true);
      v.setInt32(6, y, true);
      b[10] = 0;
      return b;
    };
    // In bounds for S (just inside 512 cells): must be accepted.
    expect(w.acceptPos(j.conn, payload((sw - 1) * POS_ONE, (sh - 1) * POS_ONE))).toBe(true);
    // Out of bounds for S but well inside L's 2048x1536: must be rejected. The pre-fix code wrongly accepted
    // this because it only ever checked against the fixed L-sized GAME_W/GAME_H.
    const w2 = new World({ id: 999002, cfg: { ...CLASSIC_SANDBOX, avatars: 1 }, seed: SANDBOX_SEED, now: () => 0 });
    const j2 = w2.join(peer, { playerId: 1 });
    expect(w2.acceptPos(j2.conn, payload(1000 * POS_ONE, 1000 * POS_ONE))).toBe(false);
  });

  it("also bounds an M room correctly (not just S and L)", () => {
    const w = new World({ id: 999003, cfg: { ...CLASSIC_SANDBOX, size: 1, avatars: 1 }, seed: SANDBOX_SEED, now: () => 0 });
    const peer = { send: () => {}, buffered: () => 0, close: () => {} };
    const j = w.join(peer, { playerId: 1 });
    const [mw, mh] = SIZE_DIMS[1]; // M: 1024x768
    const payload = (x: number, y: number) => {
      const b = new Uint8Array(11);
      const v = new DataView(b.buffer);
      v.setInt32(2, x, true);
      v.setInt32(6, y, true);
      return b;
    };
    expect(w.acceptPos(j.conn, payload((mw - 1) * POS_ONE, (mh - 1) * POS_ONE))).toBe(true);
    expect(w.acceptPos(j.conn, payload(mw * POS_ONE, 10 * POS_ONE))).toBe(false); // just past M's width
  });
});

describe("full room-join flow over the real socket (brief item 6)", () => {
  // RED (before lazy loading existed): connecting with a freshly-created room's id threw "unknown world" —
  // the HELLO handler only ever recognized ids 0 and 1 via worldKindOf. This test exercises the real flow:
  // POST /api/rooms, GET /api/rooms/:code, then a raw HELLO with that id.
  it("creates a room via the API, fetches its config, and HELLOs with its id to get a matching WELCOME", async () => {
    const s = await boot(tmp());
    const cfg = { ...CAVES_PVP, size: 0 }; // S-size cave room: distinct from both fixed worlds
    const created = await createRoom(s.port, { mode: "deathmatch", cfg });
    const fetched = await (await fetch(`http://127.0.0.1:${s.port}/api/rooms/${created.code}`)).json();
    expect(fetched.id).toBe(created.id);
    const configBytes = Buffer.from(fetched.config, "base64");
    expect(Array.from(configBytes)).toEqual(Array.from(encodeConfig(cfg)));

    const who = await register(s.port, "RoomJoiner");
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    ws.binaryType = "nodebuffer";
    const welcome = await new Promise<{ cfg: Uint8Array }>((resolve, reject) => {
      ws.on("open", () => ws.send(encodeHello(unhex(hex), created.id, who.token)));
      ws.on("error", reject);
      ws.on("message", (d: Buffer) => {
        const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        if (!m) return reject(new Error("undecodable frame"));
        if (m.t === "welcome") resolve({ cfg: m.cfg });
        else if (m.t === "reject") reject(new Error(m.reason));
      });
    });
    expect(Array.from(welcome.cfg)).toEqual(Array.from(configBytes));
    ws.close();
    expect(s.worlds.has(created.id)).toBe(true);
    expect(s.worlds.get(created.id)!.cfg).toEqual(cfg);
  });

  it("rejects HELLO for an id with no room row ('unknown room')", async () => {
    const s = await boot(tmp());
    await expect(connect(s.port, hex, { world: 999999 })).rejects.toThrow(/unknown room/);
  });

  it("a memory-only server (no RoomsStore) also refuses an unknown/room id cleanly", async () => {
    const s = await boot(null);
    await expect(connect(s.port, hex, { world: 12345 })).rejects.toThrow(/unknown room/);
  });
});

describe("the two fixed worlds are unaffected (brief verify: must keep passing unmodified)", () => {
  it("still joins world 0 and world 1 by their old ids, no room row needed", async () => {
    const s = await boot(tmp());
    const a = await connect(s.port, hex, { world: 0 });
    const b = await connect(s.port, hex, { world: 1, spectate: true });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    a.close();
    b.close();
  });

  it("an old-version HELLO still gets the version-mismatch reject against the v9 server", async () => {
    const s = await boot(tmp());
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    ws.binaryType = "nodebuffer";
    const rejected = new Promise<string>((resolve, reject) => {
      ws.on("open", () => {
        const frame = encodeHello(unhex(hex), 0);
        frame[1] = 8; // an old client's protocol version, one less than PROTOCOL_VERSION
        ws.send(frame);
      });
      ws.on("error", reject);
      ws.on("message", (d: Buffer) => {
        const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        if (m?.t === "reject") resolve(m.reason);
        else reject(new Error("expected a reject"));
      });
    });
    expect(PROTOCOL_VERSION).toBe(9);
    await expect(rejected).resolves.toBe("protocol version mismatch: new version, reload");
    ws.close();
  });
});

describe("two-client room agreement: both get the same WELCOME config and their sims agree on state hash", () => {
  it("mirrors the two-client-agreement pattern for a freshly created room", async () => {
    const s = await boot(tmp());
    const cfg = { ...CAVES_PVP, size: 0 };
    const created = await createRoom(s.port, { mode: "deathmatch", cfg });
    const who = await register(s.port, "AgreeA");
    const a = await connect(s.port, hex, { world: created.id, token: who.token });
    const b = await connect(s.port, hex, { world: created.id, spectate: true });
    const stepper = setInterval(() => (a.ls.run(100000), b.ls.run(100000)), 4);
    cleanups.push(() => clearInterval(stepper));
    a.move(10, 10);
    await waitFor(() => s.worlds.get(created.id)!.clock.lastClosed > 30, 10000, "a few ticks");
    await sleep(200);
    clearInterval(stepper);
    [a, b].forEach((x) => x.drain());
    const common = [...a.hashes.keys()].filter((t) => b.hashes.has(t));
    expect(common.length).toBeGreaterThan(0);
    for (const t of common) expect(b.hashes.get(t), `tick ${t}`).toBe(a.hashes.get(t));
    a.close();
    b.close();
  });
});

describe("unload when empty (brief item 3: uniform 2-minute timer, shortened here for the test)", () => {
  it("unloads a room after the last member leaves and the timer fires, then reloads it fresh on a later join", async () => {
    const s = await boot(tmp(), { roomUnloadMs: 200 });
    const created = await createRoom(s.port);
    const a = await connect(s.port, hex, { world: created.id });
    expect(s.worlds.has(created.id)).toBe(true);
    a.close();
    await waitFor(() => !s.worlds.has(created.id), 3000, "room unloaded after empty timeout");
    // A later join by the same id loads it fresh again (through RoomsStore, not a stale in-memory World).
    const b = await connect(s.port, hex, { world: created.id });
    expect(s.worlds.has(created.id)).toBe(true);
    b.close();
  });

  it("a join before the timer fires cancels the unload (the room stays hot)", async () => {
    const s = await boot(tmp(), { roomUnloadMs: 300 });
    const created = await createRoom(s.port);
    const a = await connect(s.port, hex, { world: created.id });
    a.close();
    await sleep(100); // well before the 300ms timer fires
    const b = await connect(s.port, hex, { world: created.id }); // cancels the pending unload
    await sleep(400); // past the original timer's deadline
    expect(s.worlds.has(created.id)).toBe(true); // still loaded: the join canceled the old timer
    b.close();
  });
});

describe("R2b fix: a first-ever HELLO rejected by caps must not leak the freshly-loaded room (review-r2b.md finding 1)", () => {
  // RED (before the fix): a brand-new room's very first HELLO, rejected by the member cap, left the just-loaded
  // World sitting in `worlds` forever (nobody ever joined it, so nothing ever calls scheduleUnload). This test
  // fails on the pre-fix code with `s.worlds.has(created.id)` true after the rejected join.
  it("a room's first HELLO, rejected by the member soft cap, is not left loaded", async () => {
    const s = await boot(tmp(), { maxMembersSoft: 0, maxMembersHard: 2 });
    const created = await createRoom(s.port);
    await expect(connect(s.port, hex, { world: created.id })).rejects.toThrow(/server busy/);
    expect(s.worlds.has(created.id)).toBe(false);
  });
});

describe("R2b fix: a cancelUnload before identity resolution can still reject must not leak a pending unload (review-r2b.md finding 2)", () => {
  // RED (before the fix): cancelUnload(w.id) ran before identity.resolve's unknown-token check, so a single
  // bad-token HELLO against a room whose unload timer was armed (its last real member just left) permanently
  // canceled that timer — the rejected join never calls w.join, so nothing ever re-arms it. This test fails on
  // the pre-fix code: the room is still loaded well past the (short, test-only) unload deadline.
  it("a bad-token HELLO to a room whose unload timer is armed does not cancel it; the room still unloads on schedule", async () => {
    const s = await boot(tmp(), { roomUnloadMs: 200 });
    const created = await createRoom(s.port, { mode: "deathmatch", cfg: { ...CAVES_PVP, size: 0 } });
    const who = await register(s.port, "GameJoiner");
    const a = await connect(s.port, hex, { world: created.id, token: who.token });
    expect(s.worlds.has(created.id)).toBe(true);
    a.close(); // last real member leaves: arms the unload timer
    await sleep(50); // well before the 200ms timer fires
    // A second HELLO to the same (now-empty, timer-armed) room, with no/unknown token: a game-mode room rejects
    // a non-spectating join with an unknown token. This must NOT cancel the already-armed unload timer.
    await expect(connect(s.port, hex, { world: created.id })).rejects.toThrow(/unknown token/);
    await waitFor(() => !s.worlds.has(created.id), 3000, "room still unloads on schedule, not leaked");
  });
});

describe("admission caps (brief item 4)", () => {
  it("rejects a join past the member hard cap with a clear reason", async () => {
    const s = await boot(tmp(), { maxMembersSoft: 1, maxMembersHard: 2 });
    const a = await connect(s.port, hex, { world: 0, spectate: true });
    // Soft cap (1) is already met; the next join is refused with "server busy" even though the hard cap (2)
    // has not been hit, matching the capacity note's "count members, not rooms" / soft-then-hard behaviour.
    await expect(connect(s.port, hex, { world: 0, spectate: true })).rejects.toThrow(/server busy/);
    a.close();
  });

  it("rejects loading a new room past the loaded-room slot cap, before the World is constructed", async () => {
    const s = await boot(tmp(), { maxLoadedRooms: 1, maxMembersSoft: 100, maxMembersHard: 100 });
    // The two fixed worlds don't count toward the loaded-room budget; filling the one allowed slot with a real
    // room, then a second room's HELLO must be refused with "server busy" (the loaded-rooms cap), not admitted
    // or mistaken for "unknown room" — and refused before any World for it is constructed (no `room.loaded`
    // event for the second room's id).
    const first = await createRoom(s.port);
    const a = await connect(s.port, hex, { world: first.id });
    const second = await createRoom(s.port);
    await expect(connect(s.port, hex, { world: second.id })).rejects.toThrow(/server busy/);
    expect(s.worlds.has(second.id)).toBe(false);
    a.close();
  });

  it("an L room counts as 2 of the loaded-room slots", async () => {
    const s = await boot(tmp(), { maxLoadedRooms: 2, maxMembersSoft: 100, maxMembersHard: 100 });
    const l = await createRoom(s.port, { cfg: { ...CLASSIC_SANDBOX, size: 2 } }); // L: weight 2, fills the cap alone
    const a = await connect(s.port, hex, { world: l.id });
    const another = await createRoom(s.port);
    await expect(connect(s.port, hex, { world: another.id })).rejects.toThrow(/server busy/);
    a.close();
  });
});
