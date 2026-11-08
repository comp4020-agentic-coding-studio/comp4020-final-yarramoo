// The sky is picked from the room seed: deterministic, every kind reachable, and a dev override only for known names.
import { describe, expect, it } from "vitest";
import { resolveSky, SKY_KINDS, skyForSeed } from "../../client/sky.ts";

describe("seed to sky", () => {
  it("the same seed always gives the same sky, within range", () => {
    for (const s of [0n, 1n, 7n, 123456789n, 0xffffffffffffffffn]) {
      expect(skyForSeed(s)).toBe(skyForSeed(s));
      expect(skyForSeed(s)).toBeGreaterThanOrEqual(0);
      expect(skyForSeed(s)).toBeLessThan(SKY_KINDS.length);
    }
  });
  it("every sky kind is reachable from some small seed, and roughly evenly", () => {
    const n = new Array(SKY_KINDS.length).fill(0);
    for (let s = 0n; s < 1000n; s++) n[skyForSeed(s)]++;
    for (const c of n) expect(c).toBeGreaterThan(100);
  });
  it("the override picks a named sky and ignores nonsense", () => {
    expect(resolveSky(5n, "rain")).toBe(SKY_KINDS.indexOf("rain"));
    expect(resolveSky(5n, "bogus")).toBe(skyForSeed(5n));
    expect(resolveSky(5n, null)).toBe(skyForSeed(5n));
  });
});
