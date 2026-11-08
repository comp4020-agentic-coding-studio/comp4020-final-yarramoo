// Brief F item 1: a tab that was hidden stays "live" in the worker, so on return it replayed at 240-480 ticks/s
// against a backlog of tens of thousands. The frame driver must switch to fast-forward ("catching-up") instead.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CATCHUP_THRESHOLD, driveFrame } from "../../client/lockstep.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

describe("a client that stopped stepping (hidden tab) and resumes", () => {
  it("reports catching-up, fast-forwards past the backlog, and goes live within a bounded time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-hidden-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const s: RunningServer = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks: 120, quiet: true });
    cleanups.push(() => s.close());
    const c = await connect(s.port, hex, { manual: true }); // receives ticks, never steps: the hidden tab
    await waitFor(() => c.ls.buffered > CATCHUP_THRESHOLD + 60, 10_000, "a backlog");
    // The frame loop resumes, one frame at a time, at 60 fps of fake time (16 ms per frame, 12 ms budget).
    let catching = false;
    let sawCatching = false;
    let frames = 0;
    let t = 0;
    const start = c.ls.simTick;
    for (; frames < 2000; frames++) {
      const r = driveFrame(c.ls, catching, 1, 12, () => (t += 0.01));
      catching = r.catching;
      if (r.entered) sawCatching = true;
      if (c.ls.buffered <= 8) break; // caught up to within a few ticks of the server
    }
    expect(sawCatching).toBe(true);
    expect(c.ls.simTick - start).toBeGreaterThan(CATCHUP_THRESHOLD); // it did not crawl at 8 ticks a frame
    expect(frames).toBeLessThan(50);
    expect(c.ls.buffered).toBeLessThan(CATCHUP_THRESHOLD);
    expect(catching).toBe(false);
    c.close();
  }, 30_000);
});
