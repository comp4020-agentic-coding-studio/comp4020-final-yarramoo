// Slice 3: per-connection RTT (server ws ping), tick lag, client step p95 from HASH, and the summary() figures.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, paintFor, sleep, waitFor } from "./helpers.ts";

let server: RunningServer;
let dir: string;
let hashHex: string;
beforeAll(async () => {
  hashHex = await buildHashHex();
  dir = mkdtempSync(join(tmpdir(), "sand-timing-"));
  server = await startServer({ port: 0, dataDir: dir, quiet: true });
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("per-connection timing", () => {
  it("connections() and summary() report rtt, lag, step p95, hash passes and ticks/s", async () => {
    const a = await connect(server.port, hashHex);
    const b = await connect(server.port, hashHex);
    a.reportStepP95 = 2.5;
    b.reportStepP95 = 0.75;
    await paintFor([a, b], 4500);
    await waitFor(() => server.connections().every((c) => c.rttMs !== undefined), 6000);
    await sleep(300);
    const conns = server.connections();
    expect(conns).toHaveLength(2);
    for (const c of conns) {
      expect(Number.isFinite(c.rttMs)).toBe(true);
      expect(c.rttMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.rttP95Ms)).toBe(true);
      expect(Number.isFinite(c.tickLag)).toBe(true);
      expect(c.tickLag!).toBeGreaterThanOrEqual(0);
      expect(c.tickLag!).toBeLessThanOrEqual(200);
      expect(c.role).toBe("painter");
      expect(c.total.paints).toBeGreaterThan(0);
    }
    expect(conns.map((c) => c.stepP95Ms).sort()).toEqual([0.75, 2.5]);
    const sum = server.summary();
    const w = sum.worlds.find((x) => x.world === 0)!;
    expect(w.online).toBe(2);
    expect(w.hashPasses).toBeGreaterThan(0);
    expect(w.hashFails).toBe(0);
    expect(w.ticksPerSec).toBeGreaterThan(40);
    expect(w.ticksPerSec).toBeLessThan(70);
    expect(sum.process.rssMb).toBeGreaterThan(0);
    expect(sum.process.dbBytes).toBeGreaterThan(0);
    a.close();
    b.close();
  });

  it("lag is undefined until a connection's first HASH", async () => {
    const c = await connect(server.port, hashHex, { manual: true });
    const mine = server.connections().find((x) => x.tickLag === undefined && x.stepP95Ms === undefined);
    expect(mine).toBeDefined();
    c.close();
  });
});

describe("close", () => {
  it("leaves no timers or event-loop monitor running", async () => {
    const s = await startServer({ port: 0, dataDir: null, quiet: true });
    const before = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await s.close();
    await sleep(50);
    const after = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    // The server's six intervals (tick, summary, stats, ping, tick sampling, plus the world clock timers) are gone.
    expect(before - after).toBeGreaterThanOrEqual(5);
    expect(s.summary().process.lagP99Ms).toBeGreaterThanOrEqual(0);
  });
});
