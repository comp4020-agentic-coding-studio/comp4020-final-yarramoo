// M2b: snapshots, cold-start restore, late join from a snapshot, desync detection and refusal of bad snapshots,
// all against the real server (own temp DATA_DIR per test) with real WebSocket clients running the real sim.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodePaint, KIND_PAINT } from "../../shared/inputs.ts";
import { compressSnapshot, encodeSnapshotUpload, encodeTick, simInputBytes } from "../../shared/protocol.ts";
import { GameDb } from "../../server/db.ts";
import { loadSim, simBuildHash } from "../../shared/sim.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, paintFor, sleep, wasmBytes, waitFor, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
  expect(hex).toBe(await simBuildHash(wasmBytes));
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-m2b-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string, snapshotEveryTicks = 120): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks, quiet: true });
  cleanups.push(() => s.close());
  return s;
}
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());

describe("cold start with a long log", () => {
  it("boots with 150k logged ticks after the snapshot (push(...frames) overflowed the stack and crashed the live app)", async () => {
    const dir = tmp();
    await (await boot(dir)).close();
    const db = new GameDb(dir);
    const row = db.getWorld(0)!;
    const N = 150_000;
    const BATCH = 5_000;
    for (let start = 1; start <= N; start += BATCH) {
      const frames: Uint8Array[] = [];
      for (let t = start; t < start + BATCH; t++) frames.push(encodeTick(t, []));
      const data = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of frames) {
        data.set(f, o);
        o += f.length;
      }
      db.appendTicks(0, start, start + BATCH - 1, row.simBuild, data);
    }
    db.close();
    const s = await boot(dir);
    expect(s.world.clock.lastClosed).toBe(N);
    expect(s.world.log.length).toBe(N);
  }, 60_000);
});

describe("a new sim build at start-up", () => {
  /** A sandbox with one verified snapshot, then the server stopped and its stored build renamed (a deploy). */
  async function storedUnderOldBuild(): Promise<{ dir: string; tick: number }> {
    const dir = tmp();
    const s = await boot(dir, 60);
    const a = await connect(s.port, hex);
    await paintFor([a], 600);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 1, 20000, "a verified snapshot");
    const tick = s.world.snapshot!.tick;
    closeAll(a);
    await s.close();
    const db = new GameDb(dir);
    db.setWorldBuild(0, "an-older-build");
    db.close();
    return { dir, tick };
  }

  it("a hung verifier refuses to start and leaves the stored world alone (review M5 slice 3 N2)", async () => {
    const { dir, tick } = await storedUnderOldBuild();
    await expect(
      startServer({ port: 0, dataDir: dir, quiet: true, verifyTimeoutMs: 300, verifierWorkerUrl: new URL("./hang-worker.ts", import.meta.url) }),
    ).rejects.toThrow(/not resetting/);
    const db = new GameDb(dir);
    expect(db.latestSnapshot(0)?.tick).toBe(tick);
    expect(db.getWorld(0)?.simBuild).toBe("an-older-build");
    db.close();
  });

  it("a real server process starts on a changed build: it does not exit while start-up waits on the verifier", async () => {
    // Vitest keeps its own event loop alive, so this must be a separate `node server/main.ts`. With the verify
    // worker unref'd and nothing else pending, Node exited mid-check (code 13) and a deploy crash-looped. Found by
    // the merge rehearsal on the real image.
    const { dir, tick } = await storedUnderOldBuild();
    const { spawn } = await import("node:child_process");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["server/main.ts"], { env: { ...process.env, DATA_DIR: dir, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    let exitCode: number | null = null;
    child.on("exit", (c) => (exitCode = c));
    cleanups.push(() => void child.kill("SIGKILL"));
    await waitFor(() => exitCode !== null || out.includes('"ev":"server.start"'), 30000, "the server to start or exit");
    expect(exitCode, out.slice(-600)).toBeNull();
    expect(out).toContain('"outcome":"kept_snapshot"');
    expect((await fetch(`http://127.0.0.1:${port}/readme/`)).status).toBe(200);
    expect(out).toContain(`"kept_snapshot_tick":${tick}`);
  }, 60_000);

  it("a snapshot the new build can restore is kept", async () => {
    const { dir, tick } = await storedUnderOldBuild();
    const s = await boot(dir);
    expect(s.world.snapshot?.tick).toBe(tick);
    expect(s.log.recent().some((e) => e.ev === "world.build_changed" && e.outcome === "kept_snapshot")).toBe(true);
  });

  it("a snapshot the new build refuses still resets the world", async () => {
    const { dir } = await storedUnderOldBuild();
    const db = new GameDb(dir);
    const snap = db.latestSnapshot(0)!;
    db.saveSnapshot(0, { tick: snap.tick + 60, hash: 0n, simBuild: "an-older-build", data: new Uint8Array([1, 2, 3]) });
    db.close();
    const s = await boot(dir);
    expect(s.world.snapshot).toBeNull();
    expect(s.log.recent().some((e) => e.ev === "world.build_changed" && e.outcome === "reset")).toBe(true);
  });
});

describe("snapshots and restart", () => {
  it("restart: a new server on the same DATA_DIR restores the world, continues numbering, and a fresh client holds the exact pre-stop state", async () => {
    const dir = tmp();
    const s1 = await boot(dir);
    const a = await connect(s1.port, hex, { manual: true });
    const b = await connect(s1.port, hex, { manual: true });
    // Manual mode: ticks queue up and we step explicitly, so we can stop at an exact tick.
    const stepper = setInterval(() => {
      a.ls.run(100000);
      b.ls.run(100000);
    }, 5);
    cleanups.push(() => clearInterval(stepper));
    await paintFor([a, b], 1500);
    await waitFor(() => s1.world.stats.snapshotsAccepted >= 1, 20000, "a verified snapshot");
    await paintFor([a, b], 500);
    // Freeze a at a tick: stop stepping, record the hash there.
    clearInterval(stepper);
    a.ls.run(100000);
    const stopTick = a.ls.simTick;
    const stopHash = a.ls.sim.stateHash();
    const lastBefore = s1.world.clock.lastClosed;
    const snapBefore = s1.world.snapshot!.tick;
    closeAll(a, b);
    await sleep(200);
    await s1.close();

    const s2 = await boot(dir);
    expect(s2.world.snapshot?.tick).toBe(snapBefore); // loaded from game.db
    expect(s2.world.clock.lastClosed).toBeGreaterThanOrEqual(lastBefore); // tick numbering continued
    expect(s2.world.log.length).toBe(s2.world.clock.lastClosed - snapBefore); // only the tail, not the history
    const c = await connect(s2.port, hex, { manual: true });
    await waitFor(() => c.counts.snapshots === 1, 5000, "snapshot");
    await waitFor(() => c.ls.latestClosed >= s2.world.clock.lastClosed, 5000, "log tail");
    // Step the fresh client to exactly stopTick (not further).
    while (c.ls.simTick < stopTick && c.ls.stepOne());
    expect(c.ls.simTick).toBe(stopTick);
    expect(c.ls.sim.stateHash()).toBe(stopHash);
    expect(s2.world.clock.lastClosed).toBeGreaterThanOrEqual(stopTick);
    c.close();
  });

  it("a late joiner after a verified snapshot gets a SNAPSHOT and fewer TICKs than the history, and agrees", async () => {
    const dir = tmp();
    const s = await boot(dir);
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    await paintFor([a, b], 1200);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 1, 20000, "a verified snapshot");
    await paintFor([a, b], 600);
    const snapTick = s.world.snapshot!.tick;
    const c = await connect(s.port, hex);
    await paintFor([a, b, c], 1500);
    await sleep(300);
    for (const x of [a, b, c]) x.drain();
    expect(c.counts.snapshots).toBeGreaterThanOrEqual(1);
    expect(c.snapshotTicks[0]).toBeGreaterThan(0);
    expect(c.snapshotTicks[0]).toBeLessThanOrEqual(snapTick);
    const total = s.world.clock.lastClosed;
    expect(c.counts.ticks).toBeLessThan(total - 60); // not the full history
    const shared = [...a.hashes.keys()].filter((k) => c.hashes.has(k) && b.hashes.has(k));
    expect(shared.length).toBeGreaterThan(5);
    for (const k of shared) {
      expect(c.hashes.get(k), `tick ${k}`).toBe(a.hashes.get(k));
      expect(b.hashes.get(k), `tick ${k}`).toBe(a.hashes.get(k));
    }
    expect(s.world.stats.resyncs).toBe(0);
    closeAll(a, b, c);
  });

  it("keeps only 5 snapshots and prunes tick_log behind the oldest", async () => {
    const dir = tmp();
    const s = await boot(dir, 60);
    const a = await connect(s.port, hex);
    await paintFor([a], 1000);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 7, 40000, "7 snapshots");
    await sleep(1200); // let a flush happen
    const ticks = s.db!.snapshotTicks(0);
    expect(ticks.length).toBe(5);
    const rows = s.db!.ticksAfter(0, 0);
    expect(rows.every((r) => r.last > ticks[0])).toBe(true);
    a.close();
  });
});

describe("hash checks", () => {
  it("catches a diverged client, resyncs it, records an incident, and it agrees again", async () => {
    const dir = tmp();
    const s = await boot(dir, 100000);
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    const bad = await connect(s.port, hex);
    await paintFor([a, b, bad], 600);
    // The test's job: a local Paint that never went through the server.
    bad.ls.sim.pushInput(simInputBytes({ player: bad.playerId, kind: KIND_PAINT, payload: encodePaint(0, 4, 100, 100, 160, 140, 20).subarray(5) }));
    await waitFor(() => bad.counts.resyncs >= 1, 15000, "RESYNC");
    expect(a.counts.resyncs).toBe(0);
    expect(b.counts.resyncs).toBe(0);
    await paintFor([a, b, bad], 4000);
    await sleep(300);
    for (const x of [a, b, bad]) x.drain();
    const inc = s.db!.incidents(0);
    expect(inc.length).toBeGreaterThanOrEqual(1);
    expect(inc[0].details.divergent).toEqual([bad.playerId]);
    expect(inc[0].details.build).toBe(hex);
    expect((inc[0].details.userAgents as Record<string, string>)[String(bad.playerId)]).toBe("vitest-client");
    // After the resync every checkpoint the bad client records matches the others.
    const after = [...bad.hashes.keys()].filter((k) => a.hashes.has(k) && k > inc[0].tick + 60);
    expect(after.length).toBeGreaterThan(5);
    for (const k of after) expect(bad.hashes.get(k), `tick ${k}`).toBe(a.hashes.get(k));
    expect(s.world.stats.resyncs).toBe(1);
    closeAll(a, b, bad);
  });

  it("with two clients that disagree, trusts the one connected longest", async () => {
    const dir = tmp();
    const s = await boot(dir, 100000);
    const old = await connect(s.port, hex);
    const young = await connect(s.port, hex);
    await paintFor([old, young], 400);
    young.ls.sim.pushInput(simInputBytes({ player: young.playerId, kind: KIND_PAINT, payload: encodePaint(0, 5, 10, 10, 60, 60, 15).subarray(5) }));
    await waitFor(() => young.counts.resyncs >= 1, 15000, "RESYNC for the younger client");
    expect(old.counts.resyncs).toBe(0);
    closeAll(old, young);
  });
});

describe("bad snapshots", () => {
  async function setup() {
    const dir = tmp();
    const s = await boot(dir, 120);
    const a = await connect(s.port, hex, { uploads: false });
    const b = await connect(s.port, hex);
    return { s, a, b };
  }

  it("refuses an upload whose bytes do not match the majority hash, and stores nothing", async () => {
    const { s, a, b } = await setup();
    let sent = 0;
    // `a` is the reference (connected longest). It claims the true hash but uploads a different world.
    a.onDue = (tick, honest) => {
      const other = loadSim(wasmBytes);
      other.init(1n, 0);
      while (other.tick() < tick) other.step(); // an empty world at the same tick: valid bytes, wrong state
      sent++;
      a.ws.send(encodeSnapshotUpload(tick, honest.hash, compressSnapshot(other.snapshot())));
    };
    await paintFor([a, b], 1200);
    await waitFor(() => s.world.stats.snapshotsRejected >= 1, 20000, "a rejected snapshot");
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(s.world.stats.snapshotsAccepted).toBe(0);
    expect(s.db!.snapshotTicks(0)).toEqual([]);
    expect(s.world.snapshot).toBeNull();
    closeAll(a, b);
  });

  it("refuses an upload that claims a hash other than the majority's, and garbage bytes", async () => {
    const { s, a, b } = await setup();
    let n = 0;
    a.onDue = (tick, honest) => {
      n++;
      if (n % 2) a.ws.send(encodeSnapshotUpload(tick, honest.hash ^ 1n, honest.data)); // honest bytes, lying claim
      else a.ws.send(encodeSnapshotUpload(tick, honest.hash, new Uint8Array([1, 2, 3, 4]))); // not zlib
    };
    await paintFor([a, b], 1800);
    await waitFor(() => s.world.stats.snapshotsRejected >= 2, 30000, "two rejected snapshots");
    expect(s.world.stats.snapshotsAccepted).toBe(0);
    expect(s.db!.snapshotTicks(0)).toEqual([]);
    closeAll(a, b);
  });

  it("ignores an unsolicited upload", async () => {
    const dir = tmp();
    const s = await boot(dir, 1000000);
    const a = await connect(s.port, hex);
    await paintFor([a], 300);
    a.ws.send(encodeSnapshotUpload(60, 1n, compressSnapshot(a.ls.sim.snapshot())));
    await sleep(300);
    expect(s.world.stats.snapshotsAccepted + s.world.stats.snapshotsRejected).toBe(0);
    a.close();
  });
});
