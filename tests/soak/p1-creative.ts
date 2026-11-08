// R4 measurement (plan-game-modes.md "Sandspiel-style brushes": "A room of 8 painters at radius 32 must
// stay inside the per-tick step budget, and R4 measures it"). A focused script, not the full G2 harness
// (memory is not the question here, step time is): one Creative room, 8 synthetic painters each stroking
// radius 32 every tick, spread across the world so their discs do not all overlap one chunk. Measures
// `step()` time in Node against the P1 budget (p95 <= 8 ms, D-087/docs/research/g2-results.md), reusing
// the same percentile method p1_bench.rs and tests/soak/p1.ts use. Run: `pnpm soak:p1-creative`.
//
// Native Node timing (no browser/CDP throttling, unlike tests/soak/p1.ts): this is the same sim code the
// server runs, in the same runtime shape (shared/sim.ts loading the production, non-dev_paint wasm, since
// a real Creative room's brushes go through cfg.paint_allowed(), not the dev_paint feature flag).
import { readFileSync, writeFileSync } from "node:fs";
import { CREATIVE, encodeConfig } from "../../shared/room.ts";
import { encodeJoin, encodePaint, encodePos } from "../../shared/inputs.ts";
import { loadSim, type Sim } from "../../shared/sim.ts";

const WASM = "sim/target/wasm32-unknown-unknown/release/sim.wasm";
const TICKS = Number(process.env.TICKS ?? 1800);
const PAINTERS = 8;
const RADIUS = 32;

function pct(v: number[], p: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(WASM));
  const sim: Sim = loadSim(bytes);
  sim.init(20261014n, encodeConfig(CREATIVE));
  const w = sim.width();
  const h = sim.height();
  // 8 painters spread evenly across the width, each stroking a short line at radius 32 near the surface,
  // so every tick's work is 8 discs of the brief's named worst case ("radius 32"). Creative has avatars
  // (cfg.avatars === 1), so the active-chunks rule (plan 6.5) only wakes chunks near an active player — a
  // real painter is also a joined avatar standing where they paint, so each gets a Join + Pos here too.
  const xs = Array.from({ length: PAINTERS }, (_, i) => Math.round(((i + 1) * w) / (PAINTERS + 1)));
  const y = Math.round(h / 3);
  const POS_ONE = 16; // 1/16-cell fixed point (sim/src/tuning.rs's POS_SHIFT), matches tests/soak/p1.ts's POS
  for (let i = 0; i < PAINTERS; i++) sim.pushInput(encodeJoin(i + 1));
  sim.step();
  xs.forEach((x, i) => sim.pushInput(encodePos(i + 1, 0, x * POS_ONE, y * POS_ONE, 0)));
  sim.step();
  const mats = [4, 5, 3, 2, 6, 10, 13, 14]; // sand, water, dirt, rock, wood, fire, gunpowder, lava: a mixed worst case
  const times: number[] = [];
  const chunks: number[] = [];
  for (let t = 0; t < TICKS; t++) {
    if (t % 2 === 0) xs.forEach((x, i) => sim.pushInput(encodePos(i + 1, 0, x * POS_ONE, y * POS_ONE, i & 1)));
    xs.forEach((x, i) => {
      const dx = ((t * 3 + i * 13) % 21) - 10; // strokes drift so the paint keeps doing real work, not a no-op repaint
      sim.pushInput(encodePaint(0, mats[i % mats.length], x + dx, y, x + dx + 4, y, RADIUS, false));
    });
    const t0 = performance.now();
    sim.step();
    times.push(performance.now() - t0);
    chunks.push(sim.ranChunks());
  }
  const summary = {
    budgetP95Ms: 8,
    painters: PAINTERS,
    radius: RADIUS,
    ticks: TICKS,
    p50: pct(times, 0.5),
    p95: pct(times, 0.95),
    p99: pct(times, 0.99),
    max: Math.max(...times),
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    chunksMean: chunks.reduce((a, b) => a + b, 0) / chunks.length,
    chunksMax: Math.max(...chunks),
    pass: pct(times, 0.95) <= 8,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2) + "\n");
  process.exitCode = summary.pass ? 0 : 1;
}

main();
