// Snapshot timing (D-100, docs/research/snapshot-timing.md): who is asked for a snapshot, and when a lapsed request is retried.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SNAPSHOT_RETRY_TICKS } from "../../server/world.ts";
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
    expect(b.counts.requests).toBeGreaterThanOrEqual(1);
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
    expect(a.counts.requests).toBeGreaterThanOrEqual(1);
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
