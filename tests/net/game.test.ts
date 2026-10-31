// M4a over the real server: identity, the game world beside the sandbox, Pos validation, off-thread
// verification, and late join through a snapshot with players present.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeServer, encodeTick, encodeInput, MAX_UPLOAD_FRAME, MAX_UPLOAD_FRAME_GAME, compressSnapshot, decompressSnapshot, maxSnapshotRawFor, maxUploadFrameFor, MAX_SNAPSHOT_RAW_GAME } from "../../shared/protocol.ts";
import { createHash } from "node:crypto";
import { KIND_JOIN, KIND_LEAVE, KIND_PAINT, encodePaint } from "../../shared/inputs.ts";
import { GameDb } from "../../server/db.ts";
import { CAVES_PVP, CLASSIC_SANDBOX } from "../../shared/room.ts";
import { ENT_PROJECTILE, EV_CAST, EV_KNOCK, loadSim } from "../../shared/sim.ts";
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
    // R2b: ids beyond the two fixed worlds now resolve through RoomsStore, so an id with no room row rejects
    // with "unknown room" (the brief's item 2), not the old "unknown world" (world 0/1's own behavior is
    // unaffected — see the "two fixed worlds" describe block in tests/net/room-join.test.ts).
    await expect(connect(s.port, hex, { world: 7 })).rejects.toThrow(/unknown room/);
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

describe("respawn Pos rule (D-078, review M4b S1)", () => {
  it("a fake life+1 then a far Pos at the real life is rejected at step 2; the entity never teleports", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Cheat");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(1000, 240);
    await sleep(60);
    const before = s.game.stats.posRejected;
    g.move(1800, 300, 0, 1); // step 1: claims a respawn; the sim drops it (stale life)
    g.move(1800, 300, 0, 0); // step 2: the real life, far away
    await sleep(150);
    stepAll(g);
    expect(s.game.stats.posRejected - before).toBe(1);
    const e = g.ls.sim.entities().find((x) => x.type === 1 && x.id === me.id)!;
    expect(Math.abs(e.x / 16 - 1800)).toBeGreaterThan(500);
    g.close();
  });
  it("a genuine respawn (life+1, far away) is accepted, and then the new life is held to the limit", async () => {
    const { PosBaselines } = await import("../../shared/avatar.ts");
    const b = new PosBaselines();
    expect(b.accept(1000 * 16, 240 * 16, 0, 100)).toBe(true);
    expect(b.accept(1800 * 16, 300 * 16, 1, 120)).toBe(true); // respawn teleport
    expect(b.accept(1800 * 16 + 5000, 300 * 16, 1, 121)).toBe(false); // new life is checked against its own baseline
    expect(b.accept(1000 * 16 + 16, 240 * 16, 0, 122)).toBe(true); // old life still has its own
    expect(b.accept(1800 * 16, 300 * 16, 9, 123)).toBe(false); // a life far ahead is not a respawn
  });

  it("two deaths between Pos inputs (life jumps by 2) is a respawn, not a permanent lockout", async () => {
    // With only life+1 accepted, a player who died twice before their next Pos sent life+2 forever,
    // every one was refused, and their position never reached the sim again until they reconnected.
    const { PosBaselines, RESPAWN_LIFE_WINDOW } = await import("../../shared/avatar.ts");
    const b = new PosBaselines();
    expect(b.accept(1000 * 16, 240 * 16, 5, 100)).toBe(true);
    expect(b.accept(1500 * 16, 260 * 16, 7, 130)).toBe(true); // died twice, respawned far away
    expect(b.accept(1500 * 16 + 16, 260 * 16, 7, 132)).toBe(true); // and keeps playing
    expect(b.accept(1000 * 16, 240 * 16, 7 + RESPAWN_LIFE_WINDOW + 1, 140)).toBe(false); // beyond the window
  });

  it("the window doesn't reopen the two-message teleport", async () => {
    const { PosBaselines, RESPAWN_LIFE_WINDOW } = await import("../../shared/avatar.ts");
    for (let ahead = 1; ahead <= RESPAWN_LIFE_WINDOW; ahead++) {
      const b = new PosBaselines();
      expect(b.accept(1000 * 16, 240 * 16, 4, 100)).toBe(true);
      expect(b.accept(1900 * 16, 300 * 16, 4 + ahead, 101)).toBe(true); // fake respawn far away
      expect(b.accept(1900 * 16, 300 * 16, 4, 102), `ahead ${ahead}`).toBe(false); // real life: still refused
    }
  });
});

describe("snapshots in the game world", () => {
  it("caps scale with the world kind", () => {
    expect(maxSnapshotRawFor(CAVES_PVP)).toBeGreaterThan(6_400_000);
    expect(maxSnapshotRawFor(CLASSIC_SANDBOX)).toBe(1 << 20);
    // R0a: derived from the config, but they must equal the constants the old per-kind helpers returned.
    expect(maxSnapshotRawFor(CAVES_PVP)).toBe(MAX_SNAPSHOT_RAW_GAME);
    expect(maxUploadFrameFor(CAVES_PVP)).toBe(MAX_UPLOAD_FRAME_GAME);
    expect(maxUploadFrameFor(CLASSIC_SANDBOX)).toBe(MAX_UPLOAD_FRAME);
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

  it("M4b: two clients cast at each other, a third joins late with bolts in flight, and all agree on the state hash", async () => {
    const s = await boot(tmp(), 60);
    const [ra, rb, rc] = [await register(s.port, "A"), await register(s.port, "B"), await register(s.port, "C")];
    const a = await connect(s.port, hex, { world: GAME, token: ra.token });
    const b = await connect(s.port, hex, { world: GAME, token: rb.token });
    // Count what the sims report, as the clients' own render code would (read-only).
    const seen = { casts: 0, knocks: 0, maxBolts: 0 };
    for (const x of [a, b]) {
      const prev = x.ls.onStepped;
      x.ls.onStepped = (tick, inputs) => {
        prev?.(tick, inputs);
        if (x !== a) return;
        for (const e of x.ls.sim.events()) {
          if (e.kind === EV_CAST) seen.casts++;
          if (e.kind === EV_KNOCK) seen.knocks++;
        }
        seen.maxBolts = Math.max(seen.maxBolts, x.ls.sim.entities().filter((e) => e.type === ENT_PROJECTILE).length);
      };
    }
    // Stand where the sim put each player. A aims at B (Push and Blast, so knockback is exercised when the line
    // is clear); B shoots up into open sky (below), so a bolt is always in flight, whatever the terrain between them.
    const at = (id: number) => a.ls.sim.entities().find((e) => e.type === 1 && e.id === id)!;
    await waitFor(() => (a.ls.run(100000), at(ra.id) !== undefined && at(rb.id) !== undefined), 5000, "both joined");
    const pa = at(ra.id);
    // B's spawn column depends on the tick it joined at, so B sometimes spawned one cell from A (its bolt hit A
    // at once) or under a tree (the bolt died in the branches), and no snapshot ever caught a bolt: 6 runs in
    // 10 failed. A first Pos for a life has no baseline (D-078), so B stands 24 cells from A, at the first
    // surface column whose sky above is open, and shoots up and away from A.
    const mv = a.ls.sim.matView();
    const W = a.ls.sim.width();
    const openUp = (x: number, top: number) => {
      for (let y = top; y > top - 40 && y >= 0; y--) if (mv[y * W + x] !== 0) return false;
      return true;
    };
    const surfaceAt = (x: number) => {
      let y = Math.floor(pa.y / 16) - 30;
      while (y < a.ls.sim.height() - 1 && mv[(y + 1) * W + x] === 0) y++;
      return y; // the feet row: the last empty cell above ground
    };
    let bx = Math.floor(pa.x / 16) + 24;
    for (const dx of [24, -24, 32, -32, 40, -40, 48, -48]) {
      const x = Math.floor(pa.x / 16) + dx;
      const fy = surfaceAt(x);
      if ([-2, -1, 0, 1, 2].every((o) => openUp(x + o, fy - 11))) {
        bx = x;
        break;
      }
    }
    const pb = { x: (bx + 0.5) * 16, y: (surfaceAt(bx) + 1) * 16 };
    const aim = Math.round(((Math.atan2(pb.y - pa.y, pb.x - pa.x) / (2 * Math.PI) + 1) % 1) * 65536) & 0xffff;
    const upAim = pb.x > pa.x ? 54613 : 43691; // 60 degrees above the horizon, away from A
    let n = 0;
    const shooter = setInterval(() => {
      n++;
      a.move(pa.x / 16, pa.y / 16, 1);
      b.move(pb.x / 16, pb.y / 16, 0);
      a.cast(n % 4 === 0 ? 1 : 0, aim, n & 0xffff);
      b.cast(0, upAim, n & 0xffff);
    }, 117); // about 7 ticks: not a divisor of the snapshot cadence, see the snapshot loop below
    const stepper = setInterval(() => (a.ls.run(100000), b.ls.run(100000)), 4);
    cleanups.push(() => (clearInterval(shooter), clearInterval(stepper)));
    // A Push bolt is in flight for only 8 ticks of each cast cycle, and snapshot ticks are multiples of 60. A
    // shooter period that divides the snapshot cadence locks every snapshot onto the same phase of the cycle (at
    // 100 ms every snapshot fell on a bolt-free tick; the sim was fine). A 7-tick period walks the phase, so
    // rejoin C on each newly verified snapshot until one has bolts in it.
    let snapTick = 0;
    let c!: TestClient;
    for (let attempt = 0, seenAccepted = 0; ; attempt++) {
      expect(attempt, "snapshots tried before one had bolts in flight").toBeLessThan(10);
      await waitFor(() => s.game.stats.snapshotsAccepted > seenAccepted, 30000, "a verified snapshot");
      seenAccepted = s.game.stats.snapshotsAccepted;
      snapTick = s.game.snapshot!.tick;
      // C joins late, manually stepped so the restored state can be looked at before any tick is applied.
      c = await connect(s.port, hex, { world: GAME, token: rc.token, manual: true });
      await waitFor(() => c.counts.snapshots === 1, 5000, "late-join snapshot");
      if (c.ls.sim.entities().some((e) => e.type === ENT_PROJECTILE)) break;
      c.close();
    }
    expect(c.ls.sim.entities().filter((e) => e.type === ENT_PROJECTILE).length, "bolts in flight in the snapshot").toBeGreaterThan(0);
    const cs = setInterval(() => c.ls.run(100000), 4);
    cleanups.push(() => clearInterval(cs));
    await waitFor(() => s.game.clock.lastClosed > snapTick + 300, 20000, "more ticks");
    clearInterval(shooter);
    await sleep(300);
    clearInterval(stepper);
    clearInterval(cs);
    [a, b, c].forEach((x) => x.drain());
    expect(seen.casts).toBeGreaterThan(10);
    expect(seen.maxBolts).toBeGreaterThan(0);
    const common = [...a.hashes.keys()].filter((t) => b.hashes.has(t) && c.hashes.has(t));
    expect(common.length).toBeGreaterThan(5);
    for (const t of common) {
      expect(b.hashes.get(t), `tick ${t} b`).toBe(a.hashes.get(t));
      expect(c.hashes.get(t), `tick ${t} c`).toBe(a.hashes.get(t));
    }
    expect(s.game.stats.resyncs).toBe(0);
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
  return z.length + 13 < MAX_UPLOAD_FRAME_GAME && raw.length < maxSnapshotRawFor(CAVES_PVP) && MAX_UPLOAD_FRAME < MAX_UPLOAD_FRAME_GAME && decompressSnapshot(z, maxSnapshotRawFor(CAVES_PVP)).length === raw.length;
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

describe("no player stays active (review M4a S4)", () => {
  it("cold start after a crash stamps a Leave for a player whose Join has no Leave", async () => {
    const dir = tmp();
    // Make the world rows, then write a log as a crashed server would have left it: a Join, no Leave.
    await (await boot(dir)).close();
    const db = new GameDb(dir);
    db.appendTicks(1, 1, 3, wasmHashHex(), new Uint8Array([...encodeTick(1, [{ player: 5, kind: KIND_JOIN, payload: new Uint8Array(0) }]), ...encodeTick(2, []), ...encodeTick(3, [])]));
    db.close();
    const s = await boot(dir);
    expect(s.game.clock.lastClosed).toBe(4); // the Leave got its own tick, appended to the log
    const me = await register(s.port, "After");
    const c = await connect(s.port, hex, { world: GAME, token: me.token });
    await waitFor(() => { stepAll(c); return c.ls.simTick >= 4; }, 20000, "replayed");
    const ghost = c.ls.sim.entities().find((e) => e.type === 1 && e.id === 5);
    expect(ghost, "the entity persists").toBeDefined();
    expect(ghost!.active).toBe(false);
    c.close();
  });

  it("a member dropped by a failed send gets a Leave", async () => {
    const s = await boot(tmp(), 120);
    const dead = { send() { throw new Error("socket gone"); }, buffered: () => 0, close() {} };
    // The welcome itself fails to send; the member is dropped and must still be left.
    const j = s.game.join(dead, { playerId: 777, name: "dead" });
    await waitFor(() => !s.game.members.has(j.conn), 3000, "dropped");
    await sleep(100);
    const kinds = s.game.log.map((f) => decodeServer(f)).flatMap((m) => (m && m.t === "tick" ? m.inputs : [])).filter((i) => i.player === 777).map((i) => i.kind);
    expect(kinds).toEqual([KIND_JOIN, KIND_LEAVE]);
  });
});

const wasmHashHex = () => Buffer.from(createHash("sha256").update(wasmBytes).digest()).toString("hex");
