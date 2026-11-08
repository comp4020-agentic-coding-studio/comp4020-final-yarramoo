// Review 8 Nov, H2 (server half): a per-address paint budget, charged what the sim charges each Paint. The sim half
// (MAX_PAINT_WORK_PER_TICK) is pinned in sim/tests/paint_bound.rs.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../server/main.ts";
import { MAX_BUCKETS, PAINT_CELLS_PER_SEC, PAINT_MAX_RADIUS, PAINT_MAX_STROKE, PaintRate, WORST_STROKE, paintCost } from "../../server/paintrate.ts";
import { encodePaint } from "../../shared/inputs.ts";
import { buildHashHex, connect, sleep, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

const payload = (x0: number, y0: number, x1: number, y1: number, r: number) => encodePaint(0, 4, x0, y0, x1, y1, r).subarray(5);

describe("H2: paint work per address", () => {
  it("mirrors the sim's paint bounds exactly (cold review: the mirror had no test)", () => {
    const sim = readFileSync(new URL("../../sim/src/sim.rs", import.meta.url), "utf8");
    const tuning = readFileSync(new URL("../../sim/src/tuning.rs", import.meta.url), "utf8");
    expect(Number(/pub const MAX_PAINT_RADIUS: i32 = (\d+);/.exec(sim)?.[1])).toBe(PAINT_MAX_RADIUS);
    expect(Number(/pub const MAX_PAINT_STROKE: i32 = (\d+);/.exec(tuning)?.[1])).toBe(PAINT_MAX_STROKE);
  });

  it("tracks at most MAX_BUCKETS addresses, even when every one has spent a little", () => {
    const r = new PaintRate();
    for (let k = 0; k < MAX_BUCKETS + 500; k++) r.take(`spoof${k}`, 1, 0);
    expect(r.size).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it("charges stamps times the disc's bounding box, with the sim's clamps", () => {
    expect(paintCost(payload(10, 10, 10, 10, 0))).toBe(1);
    expect(paintCost(payload(10, 10, 20, 12, 4))).toBe(11 * 81);
    expect(paintCost(payload(0, 0, 2000, 0, 255)), "length and radius clamp").toBe(WORST_STROKE);
  });

  it("a typical stroke stream from eight painters on one address is never refused", () => {
    const r = new PaintRate();
    // Eight painters at 30 strokes a second for ten seconds, radius 8, 40 cells a stroke (a fast drag).
    for (let ms = 0; ms < 10_000; ms += 33) for (let p = 0; p < 8; p++) expect(r.take("a", paintCost(payload(0, 0, 40, 0, 8)), ms)).toBe(true);
  });

  it("a flood of worst-case strokes from one address is cut to the rate, and other addresses are unaffected", () => {
    const r = new PaintRate();
    let took = 0;
    // 480 worst-case strokes a second (12 sockets at 40/s) for 5 s.
    for (let ms = 0; ms < 5000; ms += 1000 / 480) if (r.take("flood", WORST_STROKE, ms)) took++;
    const allowed = (PAINT_CELLS_PER_SEC * 5 + PAINT_CELLS_PER_SEC * 2) / WORST_STROKE; // 5 s of rate plus the burst
    expect(took).toBeLessThanOrEqual(Math.ceil(allowed) + 1);
    expect(took).toBeLessThan(480 * 5 * 0.2);
    expect(r.take("someone-else", WORST_STROKE, 5000)).toBe(true);
  });

  it("through a real server, an address over its budget has its paint dropped before it is stamped", async () => {
    // One worst-case stroke a second, no burst beyond two.
    const s = await startServer({ port: 0, dataDir: null, quiet: true, paintCellsPerSec: WORST_STROKE });
    cleanups.push(() => s.close());
    const open: TestClient[] = [];
    cleanups.push(() => open.forEach((c) => c.close()));
    for (let i = 0; i < 2; i++) open.push(await connect(s.port, hex));
    const before = s.stats.droppedRate;
    for (let i = 0; i < 6; i++) for (const c of open) c.paint(4, 0, 100 + i, 500, 100 + i, 40);
    await sleep(500);
    expect(s.stats.droppedRate - before, "12 worst-case strokes against a 2-stroke burst").toBeGreaterThanOrEqual(9);
    expect(s.log.recent().some((e) => e.ev === "input.rate_limited" && e.what === "paint_work")).toBe(true);
  }, 30000);
});
