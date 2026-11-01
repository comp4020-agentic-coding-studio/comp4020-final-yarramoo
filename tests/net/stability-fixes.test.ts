// Code-review fixes 1-3 (docs/research/code-review-2026-11-01.md): one event must not take down a server or room.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GameDb } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { startServer } from "../../server/main.ts";
import { SANDBOX_ID, World, type Peer } from "../../server/world.ts";
import { CLASSIC_SANDBOX, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-stability-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("fix 1: a room that cannot load rejects its client and leaves the server up", () => {
  it("rejects the HELLO, keeps serving other rooms, and leaves nothing half-registered", async () => {
    const dir = tmp();
    const s1 = await startServer({ port: 0, dataDir: dir, quiet: true });
    const config = Buffer.from(encodeConfig(CLASSIC_SANDBOX)).toString("base64");
    const res = await fetch(`http://127.0.0.1:${s1.port}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Broken", mode: "sandbox", config, visibility: "public" }) });
    const { id } = (await res.json()) as { id: number };
    await s1.close();
    // A room stored under another build with a snapshot this server can only verify through a hung verifier.
    const db = new GameDb(dir);
    db.createWorld(id, "sandbox", 1n, "an-older-build");
    db.saveSnapshot(id, { tick: 60, hash: 1n, simBuild: "an-older-build", data: new Uint8Array(64) });
    db.close();
    const s = await startServer({ port: 0, dataDir: dir, quiet: true, verifyTimeoutMs: 300, verifierWorkerUrl: new URL("./hang-worker.ts", import.meta.url) });
    cleanups.push(() => s.close());
    await expect(connect(s.port, hex, { world: id })).rejects.toThrow(/room unavailable/);
    expect(s.worlds.has(id)).toBe(false);
    expect(s.log.recent().some((e) => e.ev === "hello.failed" && e.world === id)).toBe(true);
    const ok = await connect(s.port, hex); // the sandbox still serves
    ok.close();
  }, 20000);
});

interface FakePeer extends Peer {
  frames: number;
}
const fakePeer = (): FakePeer => {
  const p: FakePeer = { frames: 0, send() { p.frames++; }, buffered: () => 0, close() {}, userAgent: "fake" };
  return p;
};

describe("fix 2: database errors in incident handling and a throwing world tick", () => {
  it("a recordIncident that throws does not escape the hash path; the resync still goes out", () => {
    let t = 1000;
    const dir = tmp();
    const db = new GameDb(dir);
    cleanups.push(() => db.close());
    db.recordIncident = () => {
      throw new Error("disk full");
    };
    const log = new EventLog({ quiet: true });
    const w = new World({ id: SANDBOX_ID, now: () => t, log, db });
    const ids = [0, 1, 2].map(() => {
      const conn = w.join(fakePeer(), {}).conn;
      w.onLive(conn, w.clock.lastClosed);
      return conn;
    });
    t += 2000;
    w.tick();
    for (const id of ids) w.members.get(id)!.minHashTick = 0;
    expect(() => {
      ids.forEach((id, i) => w.onHash(id, 60, i === 2 ? 0xbadn : 0x600dn));
    }).not.toThrow();
    expect(log.recent().some((e) => e.ev === "db.write_failed")).toBe(true);
    expect(log.recent().some((e) => e.ev === "desync")).toBe(true);
  });

  it("a world whose tick throws is closed alone; the other worlds keep ticking", async () => {
    const s = await startServer({ port: 0, dataDir: null, quiet: true });
    cleanups.push(() => s.close());
    const sandbox = s.worlds.get(0)!;
    const game = s.worlds.get(1)!;
    const a = await connect(s.port, hex);
    await sleep(200);
    game.tick = () => {
      throw new Error("boom");
    };
    const before = sandbox.clock.lastClosed;
    await waitFor(() => s.log.recent().some((e) => e.ev === "world.tick_failed" && e.world === 1), 3000, "tick_failed");
    await sleep(500);
    expect(sandbox.clock.lastClosed).toBeGreaterThan(before);
    expect(game.closing).toBe(true);
    a.close();
  });
});
