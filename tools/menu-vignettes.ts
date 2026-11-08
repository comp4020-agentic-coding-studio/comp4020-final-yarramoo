// Offline search for the menu backdrop's seed and vignettes (W3). Run: node tools/menu-vignettes.ts [from] [to]
// Scores 427 x 267 windows of the MENU_BACKDROP world for enemies (fliers count double, a boss disqualifies),
// surface in the top third, and a stand spot for the explorer. Prints the best seeds and their vignettes.
import { readFileSync } from "node:fs";
import { loadSim } from "../shared/sim.ts";
import { encodeConfig } from "../shared/room.ts";
import { MENU_BACKDROP, WINDOW_W, WINDOW_H } from "../client/menu/backdrop-config.ts";
import { skyForSeed, SKY_KINDS } from "../client/sky.ts";

const bytes = readFileSync("sim/target/wasm32-unknown-unknown/release/sim.wasm");
const from = Number(process.argv[2] ?? 1), to = Number(process.argv[3] ?? 300);
const SOLID = new Set([1, 2, 3, 4, 6, 11, 13, 15, 22, 25]);
const WEIGHT: Record<number, number> = { 0: 1, 1: 2, 2: 1, 3: 1, 5: 2, 6: 2 };
const SKY_BONUS: Record<string, number> = { dawn: 1.25, aurora: 1.25, rain: 1.15, day: 1, night: 0.9 };

interface V { x: number; y: number; camX: number; camY: number; skyY: number; treeX: number; treeY: number; score: number; n: number; fliers: number }

function scan(seed: bigint) {
  const sim = loadSim(new Uint8Array(bytes));
  sim.init(seed, encodeConfig(MENU_BACKDROP));
  const W = sim.width(), H = sim.height(), m = sim.matView();
  const en = sim.entities().filter((e) => e.type === 5).map((e) => ({ k: e.sub, x: Math.floor(e.x / 16), y: Math.floor(e.y / 16) }));
  // First solid cell per column (the surface).
  const top = new Int32Array(W);
  for (let x = 0; x < W; x++) { let y = 0; while (y < H && !SOLID.has(m[y * W + x])) y++; top[x] = y; }
  const standable = (x: number, y: number) => {
    if (x < 3 || x > W - 4 || y < 12 || y > H - 3) return false;
    if (!SOLID.has(m[(y + 1) * W + x]) || !SOLID.has(m[(y + 1) * W + x - 2]) || !SOLID.has(m[(y + 1) * W + x + 2])) return false;
    for (let dy = -10; dy <= 0; dy++) for (let dx = -3; dx <= 3; dx++) { const c = m[(y + dy) * W + x + dx]; if (SOLID.has(c) || c === 5 || c === 14 || c === 10) return false; }
    return true;
  };
  const found: V[] = [];
  for (let cx = 0; cx + WINDOW_W <= W; cx += 24) for (let cy = 40; cy + WINDOW_H <= H; cy += 20) {
    const inw = en.filter((e) => e.x >= cx && e.x < cx + WINDOW_W && e.y >= cy && e.y < cy + WINDOW_H);
    if (inw.some((e) => e.k === 4 || e.k === 7)) continue;
    if (en.some((e) => (e.k === 4 || e.k === 7) && e.x > cx - 60 && e.x < cx + WINDOW_W + 60 && e.y > cy - 40 && e.y < cy + WINDOW_H + 40)) continue;
    const fliers = inw.filter((e) => e.k === 1 || e.k === 5 || e.k === 6).length;
    if (inw.length < 3 || fliers < 1) continue;
    let surf = 0;
    for (let x = cx; x < cx + WINDOW_W; x++) if (top[x] >= cy - 20 && top[x] < cy + WINDOW_H / 3) surf++;
    if (surf < WINDOW_W * 0.3) continue;
    let sc = 0;
    for (const e of inw) sc += WEIGHT[e.k] ?? 1;
    // Explorer: the stand spot nearest the enemy centroid, in the middle half of the window.
    const mx = inw.reduce((a, e) => a + e.x, 0) / inw.length, my = inw.reduce((a, e) => a + e.y, 0) / inw.length;
    let best: { x: number; y: number; d: number } | null = null;
    for (let x = cx + WINDOW_W * 0.25; x < cx + WINDOW_W * 0.75; x += 3) for (let y = cy + 8; y < cy + WINDOW_H - 20; y++) {
      const xi = Math.floor(x);
      if (!standable(xi, y)) continue;
      const d = Math.abs(xi - mx) + Math.abs(y - my);
      if (!best || d < best.d) best = { x: xi, y, d };
    }
    if (!best) continue;
    // skyY: a row above the whole window's surface (emitters start there); tree: the top wood cell nearest the middle.
    let minTop = H;
    for (let x = cx; x < cx + WINDOW_W; x++) minTop = Math.min(minTop, top[x]);
    let tree = { x: -1, y: -1, d: 1e9 };
    for (let x = cx + 20; x < cx + WINDOW_W - 20; x++) for (let y = cy; y < cy + WINDOW_H / 2; y++) {
      if (m[y * W + x] === 6 && m[(y - 1) * W + x] === 0) { const d = Math.abs(x - (cx + WINDOW_W / 2)); if (d < tree.d) tree = { x, y, d }; break; }
    }
    found.push({ x: best.x, y: best.y, camX: cx, camY: cy, skyY: Math.max(2, minTop - 8), treeX: tree.x, treeY: tree.y, score: sc, n: inw.length, fliers });
  }
  return { found, W, H };
}

const results: { seed: number; sky: string; total: number; picks: V[] }[] = [];
for (let s = from; s <= to; s++) {
  const { found } = scan(BigInt(s));
  found.sort((a, b) => b.score - a.score);
  const picks: V[] = [];
  for (const f of found) {
    if (picks.length >= 4) break;
    if (picks.some((p) => Math.abs(p.camX - f.camX) < WINDOW_W * 0.5 && Math.abs(p.camY - f.camY) < WINDOW_H * 0.9)) continue;
    picks.push(f);
  }
  if (picks.length < 3) continue;
  const sky = SKY_KINDS[skyForSeed(BigInt(s))];
  results.push({ seed: s, sky, total: picks.reduce((a, p) => a + p.score, 0) * (SKY_BONUS[sky] ?? 1), picks });
}
results.sort((a, b) => b.total - a.total);
for (const r of results.slice(0, 8)) {
  console.log(`seed ${r.seed} sky ${r.sky} total ${r.total.toFixed(1)}`);
  for (const p of r.picks) console.log(`  { x: ${p.x}, y: ${p.y}, camX: ${p.camX}, camY: ${p.camY}, skyY: ${p.skyY}, treeX: ${p.treeX}, treeY: ${p.treeY} }, // ${p.n} mobs, ${p.fliers} fliers, score ${p.score}`);
}
