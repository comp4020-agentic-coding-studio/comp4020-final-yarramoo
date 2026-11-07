import { describe, expect, it } from "vitest";
import { Ambient, AMBIENT_CAP } from "../../client/ambient.ts";

const W = 64, H = 64, GROUND = 30;
const FLOWER = 9, STEM = 8, MOSS = 23, ROCK = 2, WATER = 5;

/** Surface at row 30; flowers and stems above it, a moss/rock ceiling and water underground. */
function world(): { mat: Uint8Array; surf: Uint16Array } {
  const mat = new Uint8Array(W * H);
  for (let y = GROUND; y < H; y++) mat.fill(3, y * W, (y + 1) * W);
  for (let x = 0; x < W; x++) {
    if (x % 2) { mat[(GROUND - 1) * W + x] = FLOWER; }
    else { mat[(GROUND - 5) * W + x] = STEM; }
  }
  // cave: empty band rows 40..46, ceiling rock above with moss, water on the floor
  for (let y = 40; y < 47; y++) mat.fill(0, y * W, (y + 1) * W);
  for (let x = 0; x < W; x++) { mat[39 * W + x] = x % 3 ? ROCK : MOSS; mat[47 * W + x] = WATER; }
  return { mat, surf: new Uint16Array(W).fill(GROUND) };
}

/** Dense canopy: stems on every other row above the ground, so leaves spawn as fast as the rate bound allows. */
function canopy(): { mat: Uint8Array; surf: Uint16Array } {
  const w = world();
  for (let y = 0; y < GROUND - 1; y += 2) for (let x = 0; x < W; x++) w.mat[y * W + x] = STEM;
  return w;
}
const VIEW = { x: 10, y: 20, w: 30, h: 35 };

describe("Ambient", () => {
  it("never exceeds its cap and never spawns outside the view", () => {
    const { mat, surf } = world();
    for (const sky of [0, 1, 2, 4]) {
      const a = new Ambient();
      a.setSky(sky);
      let max = 0;
      for (let i = 0; i < 10000; i++) {
        a.update(16, VIEW, mat, W, H, surf);
        max = Math.max(max, a.count);
        if (i % 50 === 0) for (const p of a.particles) if (p.age === 0) {
          expect(p.ox).toBeGreaterThanOrEqual(VIEW.x - 1);
          expect(p.ox).toBeLessThanOrEqual(VIEW.x + VIEW.w + 1);
        }
      }
      expect(max).toBeLessThanOrEqual(AMBIENT_CAP);
      expect(max).toBeGreaterThan(0);
    }
  });

  it("a dense canopy still stays within the cap", () => {
    const { mat, surf } = canopy();
    const a = new Ambient();
    let max = 0;
    for (let i = 0; i < 10000; i++) { a.update(16, VIEW, mat, W, H, surf); max = Math.max(max, a.count); }
    expect(max).toBe(AMBIENT_CAP);
  });

  it("spawns nothing under reduced motion", () => {
    const { mat, surf } = world();
    const a = new Ambient();
    a.setReduced(true);
    for (let i = 0; i < 2000; i++) a.update(16, VIEW, mat, W, H, surf);
    expect(a.count).toBe(0);
  });

  it("fireflies: surface only at night/aurora, but near moss at any sky", () => {
    const { mat, surf } = world();
    const run = (sky: number, m: Uint8Array): number => {
      const a = new Ambient();
      a.setSky(sky);
      let n = 0;
      for (let i = 0; i < 3000; i++) { a.update(16, VIEW, m, W, H, surf); n += a.particles.filter((p) => p.kind === "firefly").length; }
      return n;
    };
    const noMoss = world().mat;
    for (let i = 0; i < noMoss.length; i++) if (noMoss[i] === MOSS) noMoss[i] = ROCK;
    expect(run(1, noMoss)).toBe(0);
    expect(run(0, noMoss)).toBeGreaterThan(0);
    expect(run(4, noMoss)).toBeGreaterThan(0);
    expect(run(1, mat)).toBeGreaterThan(0);
  });

  it("a drip stops at a solid cell", () => {
    const { mat, surf } = world();
    const a = new Ambient();
    a.setSky(1);
    for (let i = 0; i < 3000; i++) {
      a.update(16, VIEW, mat, W, H, surf);
      for (const p of a.particles) if (p.kind === "drip") expect(mat[Math.floor(p.y) * W + Math.floor(p.x)]).toBe(0);
    }
  });
});
