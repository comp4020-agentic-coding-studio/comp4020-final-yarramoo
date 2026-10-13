// Gate G2, test P1 (plan 12.2): worst-case step time. Four players spread across the game world (four separate active
// regions), each with a large fire and a water flood started at once; step time p50/p95 over 1800 ticks in Chromium,
// at native speed and with Emulation.setCPUThrottlingRate{rate:4}. Budget p95 <= 8 ms. Run: `pnpm soak:p1`.
//
// The sim runs in the PAGE (main thread, where CDP throttling applies; it does not reach workers). It is the dev_paint
// build (`pnpm build:sim:devpaint`), because the production sim ignores Paint in a game world. That build differs from
// the shipped one only by the Paint gate (D-056). Timing is performance.now() around each `step()` call.
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../determinism/server.ts";
import { root } from "../determinism/helpers.ts";

const TICKS = Number(process.env.TICKS ?? 1800);
const WASM = resolve(root, "sim/target-devpaint/wasm32-unknown-unknown/release/sim.wasm");

interface Result {
  label: string;
  throttle: number;
  players: number;
  ticks: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  p95FirstHalf: number;
  p95SecondHalf: number;
  chunks: { mean: number; max: number; min: number };
  chunksOverTime: number[];
  over8ms: number;
  timerGranularityMs: number;
}

/** Runs inside the page. */
async function scenario(wasmUrl: string, opts: { players: number; ticks: number; fire: boolean; flood: boolean; label: string }): Promise<Omit<Result, "throttle">> {
  // Variable specifiers: these resolve in the page (served by the determinism static server), not for tsc.
  const simUrl = "/shared/sim.ts";
  const inpUrl = "/shared/inputs.ts";
  const { loadSim } = (await import(simUrl)) as typeof import("../../shared/sim.ts");
  const inp = (await import(inpUrl)) as typeof import("../../shared/inputs.ts");
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const sim = loadSim(bytes);
  sim.init(20261014n, 1);
  const POS = 16;
  // Spread across the 2048-cell world, more than the 576-cell active width apart, so the active rectangles are disjoint.
  const xs = [250, 850, 1450, 1950].slice(0, opts.players);
  const Y = 230; // about the surface
  const ids = xs.map((_, i) => i + 1);
  // Tick 1: everyone joins and is moved to their spot (Pos needs life 0, which a fresh Join has).
  ids.forEach((id) => sim.pushInput(inp.encodeJoin(id)));
  sim.step();
  ids.forEach((id, i) => sim.pushInput(inp.encodePos(id, 0, xs[i] * POS, Y * POS, 0)));
  sim.step();
  // Worst case at once, in every region: a large fire (a 120 x 30 wood pile, soaked in fire, with gunpowder in it) and a
  // flood (water strokes of radius 32 along 160 cells, three rows high, released above the player).
  const paint = (m: number, x0: number, y0: number, x1: number, y1: number, r: number) => sim.pushInput(inp.encodePaint(0, m, x0, y0, x1, y1, r));
  const WOOD = 6, FIRE = 10, WATER = 5, GUNPOWDER = 13;
  xs.forEach((x) => {
    if (opts.fire) {
      paint(WOOD, x - 60, Y - 20, x + 60, Y - 20, 14);
      paint(GUNPOWDER, x - 40, Y - 20, x + 40, Y - 20, 6);
      paint(FIRE, x - 60, Y - 34, x + 60, Y - 34, 5);
      paint(FIRE, x - 60, Y - 6, x + 60, Y - 6, 5);
    }
    if (opts.flood) {
      for (const dy of [-70, -100, -130]) paint(WATER, x - 80, Y + dy, x + 80, Y + dy, 32);
    }
  });
  const times: number[] = [];
  const chunks: number[] = [];
  for (let t = 0; t < opts.ticks; t++) {
    if (t % 2 === 0) ids.forEach((id, i) => sim.pushInput(inp.encodePos(id, 0, xs[i] * POS, Y * POS, i & 1)));
    const t0 = performance.now();
    sim.step();
    times.push(performance.now() - t0);
    chunks.push(sim.ranChunks());
  }
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  const half = Math.floor(times.length / 2);
  let g = Infinity;
  const uniq = [...new Set(times)].sort((a, b) => a - b);
  for (let i = 1; i < uniq.length; i++) g = Math.min(g, uniq[i] - uniq[i - 1]);
  const slice = (n: number) => Array.from({ length: n }, (_, k) => Math.round(chunks.slice(Math.floor((k * chunks.length) / n), Math.floor(((k + 1) * chunks.length) / n)).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(chunks.length / n))));
  return {
    label: opts.label,
    players: opts.players,
    ticks: times.length,
    p50: q(times, 0.5),
    p95: q(times, 0.95),
    p99: q(times, 0.99),
    max: Math.max(...times),
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    p95FirstHalf: q(times.slice(0, half), 0.95),
    p95SecondHalf: q(times.slice(half), 0.95),
    chunks: { mean: chunks.reduce((a, b) => a + b, 0) / chunks.length, max: Math.max(...chunks), min: Math.min(...chunks) },
    chunksOverTime: slice(6),
    over8ms: times.filter((x) => x > 8).length,
    timerGranularityMs: g,
  };
}

async function main(): Promise<void> {
  const { server, url } = await serve();
  const browser = await chromium.launch({ headless: true });
  const results: Result[] = [];
  try {
    const wasmUrl = "/" + relative(root, WASM);
    for (const rate of [1, 4]) {
      const page = await browser.newPage();
      await page.goto(`${url}/tests/determinism/runner.html`); // any page on the origin: the scenario imports modules itself
      if (rate !== 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
      const cases = [
        { players: 4, fire: true, flood: true, label: "worst case: 4 players, fire + flood each" },
        { players: 4, fire: true, flood: false, label: "split: 4 players, fire only" },
        { players: 4, fire: false, flood: true, label: "split: 4 players, flood only" },
        { players: 1, fire: true, flood: true, label: "control: 1 player, fire + flood" },
        { players: 4, fire: false, flood: false, label: "control: 4 players, nothing painted" },
      ];
      for (const c of cases) {
        const r = await page.evaluate(`(${scenario.toString()})(${JSON.stringify(wasmUrl)}, ${JSON.stringify({ ...c, ticks: TICKS })})`) as Omit<Result, "throttle">;
        results.push({ ...r, throttle: rate });
        console.log(`${rate}x  ${r.label}: p50 ${r.p50.toFixed(2)} p95 ${r.p95.toFixed(2)} max ${r.max.toFixed(1)} ms, chunks mean ${r.chunks.mean.toFixed(0)} max ${r.chunks.max}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const worst = results.filter((r) => r.label.startsWith("worst"));
  const summary = { budgetP95Ms: 8, ticks: TICKS, pass: worst.every((r) => r.p95 <= 8), worst: worst.map((r) => ({ throttle: r.throttle, p50: r.p50, p95: r.p95 })), results };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2) + "\n");
  process.exitCode = summary.pass ? 0 : 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error("P1 harness error:", e); process.exit(2); });
