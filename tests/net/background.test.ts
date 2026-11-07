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
