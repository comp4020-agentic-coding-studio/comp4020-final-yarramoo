import { describe, expect, it } from "vitest";
import { SIZZLE_GAP_MS, hitboxTouchesLava, shouldSizzle } from "../../client/hazard.ts";

const W = 40, H = 40;
const grid = () => new Uint8Array(W * H);

describe("lava sizzle", () => {
  it("finds lava inside the hitbox only", () => {
    const g = grid();
    g[20 * W + 10] = 14;
    // feet line at row 25 (y16 = 400): hitbox rows 15..24, columns 8..12 for x = 10.5 cells
    expect(hitboxTouchesLava(g, W, H, 168, 400)).toBe(true);
    expect(hitboxTouchesLava(g, W, H, 168, 288)).toBe(false); // feet at row 18: rows 8..17
    expect(hitboxTouchesLava(g, W, H, 16 * 20, 400)).toBe(false); // far to the right
    g[20 * W + 10] = 5; // water is not lava
    expect(hitboxTouchesLava(g, W, H, 168, 400)).toBe(false);
  });
  it("needs a health drop, lava contact, and the rate limit", () => {
    expect(shouldSizzle(50, 49, true, 1000, 0)).toBe(true);
    expect(shouldSizzle(50, 50, true, 1000, 0)).toBe(false);
    expect(shouldSizzle(50, 49, false, 1000, 0)).toBe(false); // hurt by something else
    expect(shouldSizzle(50, 49, true, 1000, 1000 - SIZZLE_GAP_MS + 1)).toBe(false);
    expect(shouldSizzle(50, 49, true, 1000, 1000 - SIZZLE_GAP_MS)).toBe(true);
  });
  it("continuous contact gives at most about 3-4 sizzles a second", () => {
    let last = -1e9, n = 0, hp = 100;
    for (let t = 0; t < 1000; t += 1000 / 30) { // damage every 2nd tick = 30 Hz
      const prev = hp; hp--;
      if (shouldSizzle(prev, hp, true, t, last)) { last = t; n++; }
    }
    expect(n).toBeLessThanOrEqual(4);
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
