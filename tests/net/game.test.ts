// M4a over the real server: identity, the game world beside the sandbox, Pos validation, off-thread
// verification, and late join through a snapshot with players present.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeInput, MAX_UPLOAD_FRAME, MAX_UPLOAD_FRAME_GAME, compressSnapshot, decompressSnapshot, maxSnapshotRawFor } from "../../shared/protocol.ts";
import { KIND_JOIN, KIND_PAINT, encodePaint } from "../../shared/inputs.ts";
import { loadSim } from "../../shared/sim.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, sleep, wasmBytes, waitFor, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-m4a-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string | null, snapshotEveryTicks = 120): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks, quiet: true });
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;
const stepAll = (...cs: TestClient[]) => cs.forEach((c) => c.drain());

describe("identity", () => {
  it("registers with a random token, stores only its hash, and trims and caps the name", async () => {
    const dir = tmp();
    const s = await boot(dir);
    const a = await register(s.port, "  Ada <script>alert(1)</script>\u0000‮ " + "x".repeat(60));
    const b = await register(s.port, "");
    expect(a.token).toHaveLength(32);
    expect(a.token).not.toEqual(b.token);
    expect(Array.from(a.name).length).toBeLessThanOrEqual(24);
    expect(a.name).not.toMatch(/[\u0000‮]/);
    expect(a.name.startsWith("Ada")).toBe(true);
    expect(b.name).toBe("Wanderer");
    expect(a.id).not.toBe(b.id);
    // Only the hash is in the database.
    const rows = s.db!.db.prepare("select token_hash from players").all() as { token_hash: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.some((r) => r.token_hash === Buffer.from(a.token).toString("hex"))).toBe(false);
    // Bad bodies and methods.
    expect((await fetch(`http://127.0.0.1:${s.port}/api/players`)).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/players`, { method: "POST", body: "not json" })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/players`, { method: "POST", body: "x".repeat(5000) })).status).toBeGreaterThanOrEqual(400);
  });

  it("a returning token controls the same entity, and its position is where it was", async () => {
    const dir = tmp();
    const s = await boot(dir);
    const me = await register(s.port, "Returner");
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    expect(a.playerId).toBe(me.id);
    await waitFor(() => a.ls.sim.entities().some((e) => e.type === 1 && e.id === me.id), 5000, "spawn");
    a.move(700.5, 241, 1);
    await waitFor(() => { stepAll(a); return a.ls.sim.entities().some((e) => e.type === 1 && e.id === me.id && e.x === Math.round(700.5 * 16)); }, 5000, "pos applied");
    a.close();
    await waitFor(() => s.game.playerCount === 0, 5000, "left");
    // Reconnect: same id, same place, from the log replay.
    const b = await connect(s.port, hex, { world: GAME, token: me.token });
    expect(b.playerId).toBe(me.id);
    await waitFor(() => { stepAll(b); return b.ls.simTick >= b.ls.catchUpTarget; }, 20000, "caught up");
    // The rejoin's Join is stamped just after the replay target: wait for it to land.
    await waitFor(() => { stepAll(b); return b.ls.sim.entities().some((e) => e.type === 1 && e.id === me.id && e.active); }, 5000, "rejoined");
    const mine = b.ls.sim.entities().find((e) => e.type === 1 && e.id === me.id)!;
    expect([mine.x, mine.y, mine.sub]).toEqual([Math.round(700.5 * 16), 241 * 16, 1]);
    expect(b.names.size).toBe(0); // alone: nobody else to announce
    // Two tokens, two players; an unknown token gets a fresh, different player.
    const other = await register(s.port, "Other");
    const c = await connect(s.port, hex, { world: GAME, token: other.token });
    expect(new Set([b.playerId, c.playerId]).size).toBe(2);
    // A token nobody holds is refused, so a client whose database was reset re-registers.
    await expect(connect(s.port, hex, { world: GAME, token: new Uint8Array(32).fill(7) })).rejects.toThrow(/unknown token/);
    await waitFor(() => c.names.get(me.id) === "Returner", 5000, "name of the other player");
    [b, c].forEach((x) => x.close());
  });

  it("S1: a zero-token HELLO is refused and mints nothing; unjoined registrations are evicted at the cap", async () => {
    const s = await boot(tmp());
    const before = s.identity.count;
    for (let i = 0; i < 3; i++) await expect(connect(s.port, hex, { world: GAME })).rejects.toThrow(/unknown token/);
    expect(s.identity.count).toBe(before);
    expect(s.game.playerCount).toBe(0);
    // Registrations that never joined are evicted after the grace; one that joined is kept.
    const joined = await register(s.port, "Joiner");
    const idle = await register(s.port, "Idle");
    (await connect(s.port, hex, { world: GAME, token: joined.token })).close();
    expect(s.identity.evictUnjoined(Date.now() + 1000, 0)).toBe(1);
    await expect(connect(s.port, hex, { world: GAME, token: idle.token })).rejects.toThrow(/unknown token/);
    const again = await connect(s.port, hex, { world: GAME, token: joined.token });
    expect(again.playerId).toBe(joined.id);
    again.close();
  });

  it("a second connection with the same token replaces the first, without a Leave", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Twice");
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    const b = await connect(s.port, hex, { world: GAME, token: me.token });
    await waitFor(() => a.ws.readyState === a.ws.CLOSED, 5000, "first connection closed");
    expect(b.playerId).toBe(me.id);
    await sleep(200);
    stepAll(b);
    expect(b.ls.sim.entities().find((e) => e.type === 1 && e.id === me.id)?.active).toBe(true);
    b.close();
  });
});

describe("two worlds on one server", () => {
  it("the sandbox and the game world have separate clocks, logs and sims", async () => {
    const s = await boot(tmp());
    const sb = await connect(s.port, hex, { world: 0 });
    const me = await register(s.port, "Gamer");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    expect(sb.ls.sim.width()).toBe(512);
    expect(g.ls.sim.width()).toBe(2048);
    sb.paint(4, 100, 50, 140, 50, 6);
    await sleep(400);
    expect(s.world.log.length).toBeGreaterThan(10);
    expect(s.game.log.length).toBeGreaterThan(10);
    expect(s.world.playerCount).toBe(1);
    expect(s.game.playerCount).toBe(1);
    // Closing the sandbox pauses only the sandbox.
    sb.close();
    await waitFor(() => s.world.playerCount === 0, 3000, "sandbox empty");
    // Two independent 60 Hz clocks often read the same tick, so equal counts prove nothing; a pause
    // that stops one clock and not the other is what shows they're separate.
    const t = s.game.clock.lastClosed;
    const st = s.world.clock.lastClosed;
    await sleep(300);
    expect(s.game.clock.lastClosed).toBeGreaterThan(t);
    expect(s.world.clock.lastClosed).toBe(st);
    g.close();
  });

  it("clients cannot Join, Leave or Paint in the game world, and an unknown world is refused", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Cheat");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    const before = s.stats.rejected;
    g.ws.send(encodeInput(1, KIND_JOIN, new Uint8Array(0)));
    g.ws.send(encodeInput(2, 2, new Uint8Array(0)));
    g.ws.send(encodeInput(3, KIND_PAINT, encodePaint(0, 4, 1, 1, 9, 9, 3).subarray(5)));
    await waitFor(() => s.stats.rejected - before >= 3, 3000, "three rejections");
    await expect(connect(s.port, hex, { world: 7 })).rejects.toThrow(/unknown world/);
    g.close();
  });

  it("a spectator gets no avatar and cannot send anything", async () => {
    const s = await boot(tmp());
    const sp = await connect(s.port, hex, { world: GAME, spectate: true });
    expect(sp.playerId).toBe(0);
    sp.move(10, 10);
    await sleep(200);
    expect(s.game.stats.posRejected).toBe(0);
    stepAll(sp);
    expect(sp.ls.sim.entities().filter((e) => e.type === 1)).toHaveLength(0);
    sp.close();
  });
});

describe("Pos validation (plan 7.6)", () => {
  it("accepts walking, rejects a teleport and out-of-world or malformed Pos", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Walker");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(1000, 240);
    for (let i = 1; i <= 10; i++) {
      g.move(1000 + i * 2, 240);
      await sleep(20);
    }
    expect(s.game.stats.posRejected).toBe(0);
    g.move(1500, 240); // 480 cells in a few ticks
    await sleep(100);
    expect(s.game.stats.posRejected).toBe(1);
    g.move(3000, 240);
    g.move(10, -5);
    g.move(1000, 240, 3);
    await sleep(100);
    expect(s.game.stats.posRejected).toBe(4);
    // The rejected Pos never reached the stream: the entity is still near x 1020.
    await sleep(100);
    stepAll(g);
    const e = g.ls.sim.entities().find((x) => x.type === 1 && x.id === me.id)!;
    expect(Math.abs(e.x / 16 - 1020)).toBeLessThan(8);
    // After enough time, a long walk is legal again.
    await sleep(300);
    g.move(1020 + 40, 240);
    await sleep(100);
    expect(s.game.stats.posRejected).toBe(4);
    g.close();
  });
});

describe("snapshots in the game world", () => {
  it("caps scale with the world kind", () => {
    expect(maxSnapshotRawFor(1)).toBeGreaterThan(6_400_000);
    expect(maxSnapshotRawFor(0)).toBe(1 << 20);
    expect(MAX_UPLOAD_FRAME_GAME_ok()).toBe(true);
  });

  it("verifies a game snapshot in a worker: the tick clock does not stall, and a main-thread restore would", async () => {
    const s = await boot(tmp(), 120);
    // Observe every closed tick's time on the server's own clock.
    const closes: number[] = [];
    s.game.onTickClosed = () => closes.push(performance.now());
    const me = await register(s.port, "Snap");
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    const stepper = setInterval(() => a.ls.run(100000), 4);
    cleanups.push(() => clearInterval(stepper));
    a.move(1000, 240);
    await waitFor(() => s.game.stats.snapshotsAccepted >= 1, 30000, "a verified game snapshot");
    clearInterval(stepper);
    expect(s.game.stats.snapshotsRejected).toBe(0);
    expect(s.game.stats.lastVerifyMs).toBeGreaterThan(100); // a real world was regenerated, off-thread
    // The worst gap between consecutive closed ticks while the clock ran (includes the verification window).
    let worst = 0;
    for (let i = 1; i < closes.length; i++) worst = Math.max(worst, closes[i] - closes[i - 1]);
    console.log(`[game] verify took ${s.game.stats.lastVerifyMs.toFixed(0)} ms; worst gap between closed ticks ${worst.toFixed(1)} ms over ${closes.length} ticks`);
    expect(worst).toBeLessThan(120);
    // Control: the same restore on this thread blocks it for hundreds of ms, so the measurement can see a stall.
    const sim = loadSim(wasmBytes);
    const snap = a.ls.sim.snapshot();
    const t0 = performance.now();
    sim.restore(snap);
    const blocked = performance.now() - t0;
    console.log(`[game] control: restoring on the main thread blocks it for ${blocked.toFixed(0)} ms`);
    expect(blocked).toBeGreaterThan(worst);
    a.close();
  });

  it("D9: a client joining late gets the verified game snapshot with players in it, and agrees on the state hash", async () => {
    const s = await boot(tmp(), 120);
    const [ra, rb, rc] = [await register(s.port, "A"), await register(s.port, "B"), await register(s.port, "C")];
    const a = await connect(s.port, hex, { world: GAME, token: ra.token });
    const b = await connect(s.port, hex, { world: GAME, token: rb.token });
    const mover = setInterval(() => {
      const t = performance.now() / 1000;
      a.move(1000 + 30 * Math.sin(t * 2), 238, Math.sin(t * 2) > 0 ? 1 : 0);
      b.move(1010 + 25 * Math.cos(t * 1.7), 238, 0);
    }, 33);
    const stepper = setInterval(() => (a.ls.run(100000), b.ls.run(100000)), 4);
    cleanups.push(() => (clearInterval(mover), clearInterval(stepper)));
    await waitFor(() => s.game.stats.snapshotsAccepted >= 1, 30000, "a verified snapshot");
    const snapTick = s.game.snapshot!.tick;
    // C joins late: snapshot (with entities) + the log tail.
    const c = await connect(s.port, hex, { world: GAME, token: rc.token });
    c.move(1005, 238);
    await waitFor(() => c.counts.snapshots === 1, 5000, "late-join snapshot");
    expect(c.snapshotTicks[0]).toBeGreaterThanOrEqual(snapTick);
    const cs = setInterval(() => c.ls.run(100000), 4);
    cleanups.push(() => clearInterval(cs));
    await waitFor(() => s.game.clock.lastClosed > snapTick + 300, 20000, "more ticks");
    clearInterval(mover);
    await sleep(300);
    clearInterval(stepper);
    clearInterval(cs);
    [a, b, c].forEach((x) => x.drain());
    // Compare the hashes the clients recorded at shared ticks (they include every player's state).
    const common = [...a.hashes.keys()].filter((t) => b.hashes.has(t) && c.hashes.has(t));
    expect(common.length).toBeGreaterThan(5);
    for (const t of common) {
      expect(b.hashes.get(t), `tick ${t} b`).toBe(a.hashes.get(t));
      expect(c.hashes.get(t), `tick ${t} c`).toBe(a.hashes.get(t));
    }
    expect(s.game.stats.resyncs).toBe(0);
    // Everyone sees everyone: three players in the entity view of each client.
    for (const x of [a, b, c]) expect(x.ls.sim.entities().filter((e) => e.type === 1 && e.active)).toHaveLength(3);
    // The avatars really moved (the state is not three idle players).
    expect(Math.abs(a.ls.sim.entities().find((e) => e.type === 1 && e.id === ra.id)!.x / 16 - 1024)).toBeGreaterThan(0);
    [a, b, c].forEach((x) => x.close());
  });

  it("cold start restores the game world's players from snapshot and log", async () => {
    const dir = tmp();
    const s1 = await boot(dir, 120);
    const me = await register(s1.port, "Persist");
    const a = await connect(s1.port, hex, { world: GAME, token: me.token });
    const stepper = setInterval(() => a.ls.run(100000), 4);
    a.move(900, 240, 1);
    await waitFor(() => s1.game.stats.snapshotsAccepted >= 1, 30000, "snapshot");
    a.move(905, 240, 1);
    await sleep(300);
    clearInterval(stepper);
    a.close();
    await waitFor(() => s1.game.playerCount === 0, 3000, "left");
    await s1.close();
    const s2 = await boot(dir, 120);
    expect(s2.game.snapshot).not.toBeNull();
    const b = await connect(s2.port, hex, { world: GAME, token: me.token });
    expect(b.playerId).toBe(me.id);
    await waitFor(() => { stepAll(b); return b.ls.simTick >= b.ls.catchUpTarget; }, 30000, "replayed");
    const e = b.ls.sim.entities().find((x) => x.type === 1 && x.id === me.id)!;
    expect(e.x).toBe(905 * 16);
    b.close();
  });
});

function MAX_UPLOAD_FRAME_GAME_ok(): boolean {
  // A worst-case all-live game snapshot, compressed, still fits the game's frame cap.
  const sim = loadSim(wasmBytes);
  sim.init(1n, 1);
  const raw = new Uint8Array(768 * (2 + 8192) + 100_000);
  let x = 123456789;
  // Cell-like bytes: materials 0..14 with runs and noise, a pessimistic mix.
  for (let i = 0; i < raw.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    raw[i] = (x >>> 16) % 15;
  }
  const z = compressSnapshot(raw);
  return z.length + 13 < MAX_UPLOAD_FRAME_GAME && raw.length < maxSnapshotRawFor(1) && MAX_UPLOAD_FRAME < MAX_UPLOAD_FRAME_GAME && decompressSnapshot(z, maxSnapshotRawFor(1)).length === raw.length;
}

describe("connection limits (review M4a S2)", () => {
  it("refuses a cross-origin registration, allows same-origin and no Origin, honours an explicit allowance", async () => {
    const s = await boot(tmp());
    const url = `http://127.0.0.1:${s.port}/api/players`;
    const post = (origin?: string) => fetch(url, { method: "POST", body: "{}", headers: origin ? { origin } : {} });
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post(`http://127.0.0.1:${s.port}`)).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(s.stats.originRefused).toBe(1);
    expect(s.identity.count).toBe(2);
    const t = await startServer({ port: 0, dataDir: tmp(), quiet: true, allowedOrigins: ["http://localhost:5173"] });
    cleanups.push(() => t.close());
    const ok = await fetch(`http://127.0.0.1:${t.port}/api/players`, { method: "POST", body: "{}", headers: { origin: "http://localhost:5173" } });
    expect(ok.status).toBe(200);
  });

  it("caps connections per address and members per world", async () => {
    const s = await startServer({ port: 0, dataDir: tmp(), quiet: true, maxConnsPerIp: 3 });
    cleanups.push(() => s.close());
    const a = [await connect(s.port, hex, { world: GAME, spectate: true }), await connect(s.port, hex, { world: GAME, spectate: true }), await connect(s.port, hex, { world: GAME, spectate: true })];
    await expect(connect(s.port, hex, { world: GAME, spectate: true })).rejects.toThrow();
    expect(s.stats.capRefused).toBe(1);
    a[0].close();
    await waitFor(() => s.game.playerCount === 2, 3000, "one left");
    const b = await connect(s.port, hex, { world: GAME, spectate: true }); // the slot is free again
    [...a.slice(1), b].forEach((x) => x.close());
    // The per-world cap counts spectators too.
    const t = await startServer({ port: 0, dataDir: tmp(), quiet: true, maxMembersPerWorld: 2 });
    cleanups.push(() => t.close());
    const c1 = await connect(t.port, hex, { world: GAME, spectate: true });
    const c2 = await connect(t.port, hex, { world: GAME, spectate: true });
    await expect(connect(t.port, hex, { world: GAME, spectate: true })).rejects.toThrow(/world is full/);
    [c1, c2].forEach((x) => x.close());
  });

  it("drops a slow reader at send time, and a join shares one snapshot frame", async () => {
    const s = await boot(tmp(), 120);
    const me = await register(s.port, "Snapper");
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    const stepper = setInterval(() => a.ls.run(100000), 4);
    cleanups.push(() => clearInterval(stepper));
    await waitFor(() => s.game.snapshotFrameForTest() !== null, 30000, "a snapshot");
    expect(s.game.snapshotFrameForTest()).toBe(s.game.snapshotFrameForTest()); // same buffer, not re-encoded
    // A peer whose queue is over the cap is closed on the first send, with a Leave stamped for its player.
    let closed = "";
    const slow = { send() {}, buffered: () => 9 * 1024 * 1024, close: (_c: number, r: string) => { closed = r; } };
    const joined = s.game.join(slow, { playerId: 9999, name: "slow" });
    expect(closed).toBe("too slow");
    await waitFor(() => !s.game.members.has(joined.conn), 3000, "slow member removed");
    a.close();
  });
});

describe("snapshot verification failures (review M4a S3)", () => {
  async function runUntil(s: RunningServer, cond: () => boolean, what: string) {
    const me = await register(s.port, "V" + Math.random());
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    const stepper = setInterval(() => a.ls.run(100000), 4);
    cleanups.push(() => clearInterval(stepper));
    await waitFor(cond, 40000, what);
    clearInterval(stepper);
    a.close();
  }

  it("a hung worker is terminated, and the upload is dropped, not waited on", async () => {
    const dir = tmp();
    const s = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks: 120, quiet: true, verifyTimeoutMs: 600, verifierWorkerUrl: new URL("./hang-worker.ts", import.meta.url) });
    cleanups.push(() => s.close());
    await runUntil(s, () => s.verifier!.timeouts >= 1, "a verification timeout");
    expect(s.game.stats.snapshotsAccepted).toBe(0);
    expect(s.game.verifying).toBe(false); // not waiting forever
    await waitFor(() => s.game.stats.snapshotsRejected >= 1, 3000, "the dropped upload is counted");
  });

  it("a failing saveSnapshot is logged and rejected, not an unhandled rejection", async () => {
    const s = await boot(tmp(), 120);
    let calls = 0;
    s.db!.saveSnapshot = () => {
      calls++;
      throw new Error("disk full");
    };
    await runUntil(s, () => calls >= 1, "a save attempt");
    await waitFor(() => s.game.stats.snapshotsRejected >= 1, 3000, "counted as rejected");
    expect(s.game.stats.snapshotsAccepted).toBe(0);
    await sleep(100);
  });
});
