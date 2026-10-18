// Snapshot timing (D-100, docs/research/snapshot-timing.md): who is asked for a snapshot, and when a lapsed request is retried.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SNAPSHOT_RETRY_TICKS } from "../../server/world.ts";
import { GameDb } from "../../server/db.ts";
import { encodeTick } from "../../shared/protocol.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
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
  const d = mkdtempSync(join(tmpdir(), "sand-snaptime-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string, snapshotEveryTicks = 120): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks, quiet: true });
  cleanups.push(() => s.close());
  return s;
}
const requests = (s: RunningServer) => s.log.recent().filter((e) => e.ev === "snapshot.requested");
const lastReq = (s: RunningServer): number => (s.world as unknown as { lastRequestTick: number }).lastRequestTick;

describe("who is asked for a snapshot", () => {
  it("a member that is not live (no HASH yet) is never asked, even when it is the longest connected", async () => {
    const s = await boot(tmp());
    const a = await connect(s.port, hex, { manual: true }); // lowest seq, never stepped: sends no HASH
    const b = await connect(s.port, hex);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 1, 30000, "a verified snapshot");
    expect(a.counts.requests).toBe(0);
    await waitFor(() => b.counts.requests >= 1, 3000, "b to receive a request");
    expect(requests(s).length).toBeGreaterThanOrEqual(1);
    a.close();
    b.close();
  });

  it("with no live member nothing is requested and lastRequestTick is untouched; a request follows once one goes live", async () => {
    const s = await boot(tmp());
    const a = await connect(s.port, hex, { manual: true });
    const before = lastReq(s);
    await waitFor(() => s.world.clock.lastClosed >= before + 300, 15000, "well past two cycles");
    expect(requests(s)).toHaveLength(0);
    expect(a.counts.requests).toBe(0);
    expect(lastReq(s)).toBe(before);
    const at = s.world.clock.lastClosed;
    const stepper = setInterval(() => a.ls.run(100000), 5);
    cleanups.push(() => clearInterval(stepper));
    await waitFor(() => requests(s).length >= 1, 15000, "a request once live");
    expect(requests(s)[0]!.from_tick as number - at).toBeLessThanOrEqual(300);
    await waitFor(() => a.counts.requests >= 1, 3000, "the frame to arrive"); // the server logs before the socket delivers
    a.close();
  });
});

describe("a lapsed request", () => {
  it("is retried about SNAPSHOT_RETRY_TICKS after it lapses, not a full cycle later", async () => {
    const EVERY = 1800;
    const s = await boot(tmp(), EVERY);
    const a = await connect(s.port, hex, { uploads: false });
    await waitFor(() => s.world.requestSnapshot(), 10000, "a live member to ask");
    await waitFor(() => s.log.recent().some((e) => e.ev === "snapshot.abandoned"), 20000, "the lapse");
    const lapsedAt = s.world.clock.lastClosed;
    await waitFor(() => requests(s).length >= 2, 20000, "the retry");
    const first = requests(s)[0]!.from_tick as number;
    const second = requests(s)[1]!.from_tick as number;
    // Lapse is at request tick + 600 (+ at most a few ticks of polling); the retry is SNAPSHOT_RETRY_TICKS after it.
    expect(second - first).toBeLessThan(EVERY);
    expect(second - lapsedAt).toBeGreaterThanOrEqual(SNAPSHOT_RETRY_TICKS - 60);
    expect(second - lapsedAt).toBeLessThanOrEqual(SNAPSHOT_RETRY_TICKS + 60);
    a.close();
  }, 60_000);
});

describe("a log past the cap", () => {
  it("still accepts joins, and logs world.log_long at the warn length and at the cap", async () => {
    const s = await startServer({ port: 0, dataDir: tmp(), snapshotEveryTicks: 1_000_000, maxLogTicks: 90, warnLogTicks: 40, quiet: true });
    cleanups.push(() => s.close());
    const a = await connect(s.port, hex, { manual: true });
    await waitFor(() => s.world.log.length >= 100, 10000, "a log past the cap");
    expect(s.world.full).toBe(true);
    const b = await connect(s.port, hex, { manual: true }); // used to reject with "world log is full"
    expect(b.playerId).toBeGreaterThanOrEqual(0);
    const long = s.log.recent().filter((e) => e.ev === "world.log_long");
    expect(long.map((e) => e.limit)).toEqual(["warn", "cap"]);
    expect(long.every((e) => e.lvl === "warn")).toBe(true);
    a.close();
    b.close();
  });
});

const summary = async (s: RunningServer) => ((await (await fetch(`http://127.0.0.1:${s.port}/api/summary`)).json()) as any).worlds[0];

describe("recovery from a long log", () => {
  it("a lone client replays 20,000 logged ticks, is asked once live, and ticksSinceSnapshot falls", async () => {
    const dir = tmp();
    await (await boot(dir)).close();
    const db = new GameDb(dir);
    const row = db.getWorld(0)!;
    const N = 20_000;
    for (let start = 1; start <= N; start += 5000) {
      const frames: Uint8Array[] = [];
      for (let t = start; t < start + 5000; t++) frames.push(encodeTick(t, []));
      const data = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of frames) {
        data.set(f, o);
        o += f.length;
      }
      db.appendTicks(0, start, start + 4999, row.simBuild, data);
    }
    db.close();
    const s = await boot(dir);
    expect((await summary(s)).ticksSinceSnapshot).toBeGreaterThanOrEqual(N);
    const c = await connect(s.port, hex);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 1, 60000, "a verified snapshot");
    const after = await summary(s);
    // An empty-tick log replays in well under a second here, so this passes on the old code too: it is a recovery
    // smoke test. The old failure needs a log slow enough to replay (a heavy heap); see docs/research/snapshot-timing.md.
    expect(after.snapshotTick).toBeGreaterThan(N);
    expect(after.ticksSinceSnapshot).toBeLessThan(2000);
    c.close();
  }, 120_000);
});

describe("the log-length field", () => {
  it("ticksSinceSnapshot grows with the clock and drops when a snapshot is accepted", async () => {
    const s = await boot(tmp());
    const c = await connect(s.port, hex);
    const early = await summary(s);
    expect(early.ticksSinceSnapshot).toBe(early.lastTick - early.snapshotTick);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 1, 30000, "a snapshot");
    const after = await summary(s);
    expect(after.snapshotTick).toBeGreaterThan(0);
    expect(after.ticksSinceSnapshot).toBe(after.lastTick - after.snapshotTick);
    c.close();
  });
});
