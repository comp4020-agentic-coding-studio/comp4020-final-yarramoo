// Dev-only generator preview: regenerates the game world for a seed, terrain and size and draws the whole
// thing, with a readout. Served by the vite dev server only. vite builds from index.html alone, so this page
// never reaches dist/ (pinned by tests/net/gen-preview-dev-only.test.ts). It runs its own copy of the sim and
// never touches a real world. R1: terrain and size are both selectable, not hardcoded to Caves L.
import { DEEP_TOP, paletteTable, SHALLOW_TOP } from "./materials.ts";
import { ENT_PICKUP, loadSim } from "../shared/sim.ts";
import { CAVES_PVP, CLASSIC_SANDBOX, encodeConfig } from "../shared/room.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bytes = new Uint8Array(await (await fetch("/sim.wasm")).arrayBuffer());
const sim = loadSim(bytes);

const EMPTY = 0, WATER = 5, LAVA = 14;
const pal = paletteTable();

/** Connected components of cells where `pred` holds (4-neighbour); returns each component's size. */
function components(mat: Uint8Array, w: number, h: number, pred: (m: number) => boolean): number[] {
  const seen = new Uint8Array(w * h);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !pred(mat[i])) continue;
    let n = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      n++;
      const x = j % w;
      const y = (j - x) / w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && !seen[k] && pred(mat[k])) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    sizes.push(n);
  }
  return sizes;
}

/** L's `SHALLOW_TOP`/`DEEP_TOP` (shared/stats.ts), scaled to another world's usable height, the same
 * ratio `sim/src/gen.rs`'s `Scale::new` uses, so the band lines in the readout and the overlay line up
 * with where the generator actually drew them at S and M, not just at L. */
const FLOOR_ROWS = 64;
const scaleBand = (h: number, v: number) => Math.floor((v * (h - FLOOR_ROWS)) / (1536 - FLOOR_ROWS));

function generate(seed: bigint, terrain: number, size: number) {
  const base = terrain === 0 ? CAVES_PVP : CLASSIC_SANDBOX;
  const cfg = { ...base, terrain, size, avatars: terrain === 0 ? 1 : 0 };
  const t0 = performance.now();
  sim.init(seed, encodeConfig(cfg));
  const ms = performance.now() - t0;
  const w = sim.width();
  const h = sim.height();
  const [shallowTop, deepTop] = terrain === 0 ? [scaleBand(h, SHALLOW_TOP), scaleBand(h, DEEP_TOP)] : [0, 0];
  const mat = sim.matView().slice(0, w * h);
  const canvas = $<HTMLCanvasElement>("map");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const c = mat[i] === EMPTY ? 0x10131c : pal[mat[i]];
    img.data[i * 4] = (c >> 16) & 255;
    img.data[i * 4 + 1] = (c >> 8) & 255;
    img.data[i * 4 + 2] = c & 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Pickups, with the band they sit in (Caves only; the other terrains have none).
  const band = (y: number) => (y < shallowTop ? 0 : y < deepTop ? 1 : 2);
  const names = ["surface", "shallow", "deep"];
  const pickups = [0, 0, 0];
  ctx.fillStyle = "#ff0";
  for (const e of sim.entities()) {
    if (e.type !== ENT_PICKUP || !e.active) continue;
    const x = Math.floor(e.x / 16);
    const y = Math.floor(e.y / 16) - 1;
    pickups[band(y)]++;
    ctx.fillRect(x - 3, y - 3, 7, 7);
  }
  // Band boundaries, scaled to this world's size (Caves only).
  if (terrain === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(0, shallowTop, w, 1);
    ctx.fillRect(0, deepTop, w, 1);
  }
  const open = (m: number) => m === EMPTY || m === WATER || m === LAVA;
  let openCells = 0;
  for (let i = 0; i < w * h; i++) if (open(mat[i])) openCells++;
  const caves = components(mat, w, h, (m) => m === EMPTY).filter((n) => n >= 100);
  const water = components(mat, w, h, (m) => m === WATER);
  const lava = components(mat, w, h, (m) => m === LAVA);
  // Reachable from the sky: flood from every open cell in row 0.
  const reach = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) if (open(mat[x])) { reach[x] = 1; stack.push(x); }
  let reached = 0;
  while (stack.length) {
    const j = stack.pop()!;
    reached++;
    const x = j % w;
    const y = (j - x) / w;
    for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
      if (k >= 0 && !reach[k] && open(mat[k])) { reach[k] = 1; stack.push(k); }
    }
  }
  const pct = (a: number, b: number) => ((100 * a) / b).toFixed(1) + "%";
  const terrainNames = ["Caves", "Solid box", "Empty box"];
  const sizeNames = ["S", "M", "L"];
  const lines = [
    `seed ${seed}   ${terrainNames[terrain]} ${sizeNames[size]} (${w} x ${h}, generated in ${ms.toFixed(0)} ms)`,
    `open cells      ${openCells}  (${pct(openCells, w * h)})`,
    `reachable       ${reached} of ${openCells} open (${pct(reached, openCells)}) from the sky`,
    `caves (>=100)   ${caves.length}, largest ${Math.max(0, ...caves)}`,
    `water pools     ${water.length}  (${water.reduce((a, b) => a + b, 0)} cells)`,
    `lava pools      ${lava.length}  (${lava.reduce((a, b) => a + b, 0)} cells)`,
  ];
  if (terrain === 0) {
    lines.push(...names.map((n, i) => `pickups ${n.padEnd(8)} ${pickups[i]}`), `pickups total   ${pickups.reduce((a, b) => a + b, 0)}`);
  }
  $("out").textContent = lines.join("\n");
  $("status").textContent = "";
}

const seedEl = $<HTMLInputElement>("seed");
const terrainEl = $<HTMLSelectElement>("terrain");
const sizeEl = $<HTMLSelectElement>("size");
const params = () => new URLSearchParams({ seed: seedEl.value.trim() || "0", terrain: terrainEl.value, size: sizeEl.value });
const run = () => {
  try {
    generate(BigInt(seedEl.value.trim() || "0"), Number(terrainEl.value), Number(sizeEl.value));
    history.replaceState(null, "", "?" + params());
  } catch (e) {
    $("status").textContent = String(e);
  }
};
const step = (d: bigint) => {
  try {
    seedEl.value = String(BigInt(seedEl.value) + d);
  } catch {
    seedEl.value = "1";
  }
  run();
};
$("f").onsubmit = (e) => {
  e.preventDefault();
  run();
};
$("prev").onclick = () => step(-1n);
$("next").onclick = () => step(1n);
terrainEl.onchange = run;
sizeEl.onchange = run;
const q = new URLSearchParams(location.search);
seedEl.value = q.get("seed") ?? "1";
terrainEl.value = q.get("terrain") ?? "0";
sizeEl.value = q.get("size") ?? "2";
run();
