// The sky line is captured once from the generated world (client/background.ts) and the renderer never recomputes
import { readFileSync } from "node:fs";
// it from live cells. A source guard covers the renderer (it needs WebGL); the pure function is tested directly.
import { describe, expect, it } from "vitest";
import { groundLine } from "../../client/background.ts";

const ROCK = 2;
const WOOD = 6;
const SNOW = 27;
const WATER = 5;

function grid(w: number, h: number, surface: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let y = surface; y < h; y++) g.fill(ROCK, y * w, (y + 1) * w);
  return g;
}

describe("groundLine", () => {
  it("is the first run of 3 solid cells in each column", () => {
    const line = groundLine(grid(8, 40, 20), 8, 40);
    expect([...line]).toEqual(new Array(8).fill(20));
  });

  it("ignores wood and water on the surface, so the sky shows behind them", () => {
    const g = grid(8, 40, 20);
    for (let y = 10; y < 20; y++) g[y * 8 + 3] = WOOD;
    for (let y = 15; y < 20; y++) g[y * 8 + 5] = WATER;
    expect(groundLine(g, 8, 40)[3]).toBe(20);
    expect(groundLine(g, 8, 40)[5]).toBe(20);
  });

  it("captured once, the line does not move when a wall is painted above the surface later", () => {
    const g = grid(8, 40, 20);
    const captured = groundLine(g, 8, 40);
    for (let y = 8; y < 20; y++) for (let x = 2; x < 6; x++) g[y * 8 + x] = SNOW;
    // A live recomputation would now say 8: that is the bug. The captured line is untouched.
    expect(groundLine(g, 8, 40)[3]).toBe(8);
    expect(captured[3]).toBe(20);
  });

  it("ignores a surface ruin's Brick, so the sky shows inside a ruined house and above a well's coping", () => {
    const BRICK = 22;
    const w = 40;
    const g = grid(w, 60, 30);
    // A house: a far wall 2 wide from row 14 to the floor, a 2-row roof, a brick footing on the ground.
    for (let y = 14; y < 30; y++) for (const x of [20, 21]) g[y * w + x] = BRICK;
    for (let x = 6; x < 22; x++) { g[14 * w + x] = WOOD; g[15 * w + x] = WOOD; }
    for (const x of [6, 7]) for (let y = 14; y < 17; y++) g[y * w + x] = BRICK;
    const line = groundLine(g, w, 60);
    for (const x of [6, 10, 15, 20, 21]) expect(line[x]).toBe(30);
  });

  // 9 Nov screenshot: beside a hill, the back wall stood in the sky as a flat block with a vertical edge. The old rim
  // was the highest ground within 64 columns either side, and only columns more than 12 below it closed, so the
  // wall's edge stood over open funnel cells whose ground was up to 12 rows lower.
  it("closes a cave mouth beside a hill flush with the terrain, with no wall standing in open air", () => {
    const w = 200, h = 140;
    const g = new Uint8Array(w * h);
    // Ground at row 40 on the left, a hill at row 20 on the right, a valley floor at row 60 between them, and a shaft
    // (x 92-100) dropping out of the valley floor: the screenshot's mouth at the foot of a hill.
    const top = (x: number) => (x < 50 ? 40 : x > 140 ? 20 : x < 70 ? 40 + (x - 50) : x > 120 ? 60 - 2 * (x - 120) : 60);
    for (let x = 0; x < w; x++) for (let y = top(x); y < h; y++) g[y * w + x] = ROCK;
    for (let x = 92; x <= 100; x++) for (let y = 60; y < 130; y++) g[y * w + x] = 0;
    const surface = (x: number) => { let y = 0; while (y < h && g[y * w + x] === 0) y++; return y; };
    const line = groundLine(g, w, h);
    expect(line[96]).toBeLessThan(surface(96)); // the shaft is closed
    // Wherever the line sits above the surface (back wall drawn), each neighbour is wall at the same height or ground
    // at most 2 rows below it: the wall never ends in a vertical edge over open air.
    for (let x = 0; x < w; x++) {
      if (line[x] >= surface(x)) continue;
      for (const n of [x - 1, x + 1]) {
        if (n < 0 || n >= w) continue;
        const ok = line[n] === line[x] || surface(n) <= line[x] + 2;
        expect(ok, `wall at x=${x} (row ${line[x]}) ends over open air at x=${n} (line ${line[n]}, ground ${surface(n)})`).toBe(true);
      }
    }
  });

  it("leaves a wide valley between hills as sky", () => {
    const w = 200, h = 120;
    const g = new Uint8Array(w * h);
    const top = (x: number) => (x < 40 || x > 160 ? 30 : 30 + Math.round(50 * Math.sin(((x - 40) / 120) * Math.PI)));
    for (let x = 0; x < w; x++) for (let y = top(x); y < h; y++) g[y * w + x] = ROCK;
    const line = groundLine(g, w, h);
    for (let x = 0; x < w; x++) expect(line[x]).toBe(top(x));
  });

  it("closes a generated shaft at its rim", () => {
    const w = 20;
    const g = grid(w, 80, 20);
    for (let y = 20; y < 60; y++) g[y * w + 10] = 0;
    expect(groundLine(g, w, 80)[10]).toBe(20);
  });
});
describe("renderer", () => {
  it("has no periodic surface recomputation from live cells", () => {
    const src = readFileSync(new URL("../../client/render.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/updateSurface/);
    expect(src).not.toMatch(/GROUND\[/);
    expect(src).toMatch(/setBackground/);
  });
});

describe("grass shader guard", () => {
  const src = readFileSync(new URL("../../client/render.ts", import.meta.url), "utf8");
  it("has a grass branch gated on game worlds (uBands.x)", () => {
    expect(src).toMatch(/bool grassTop\(ivec2 p\)\s*\{\s*if \(uBands\.x < 0\.5/);
    expect(src).toMatch(/if \(uBands\.x > 0\.5\) \{\s*\/\/ Grass blades/);
    expect(src).toMatch(/if \(grassTop\(c\)\) col = g;/);
    expect(src).toMatch(/uSky\.y/);
  });
});
