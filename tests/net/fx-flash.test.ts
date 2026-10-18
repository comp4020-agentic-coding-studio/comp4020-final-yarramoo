// The explosion flash is drawn as a disc, not one square: a bomb's 22-cell flash drawn as a single square read as a
// square crater in the screenshots (the real crater, carved by the sim, is round).
import { describe, expect, it } from "vitest";
import { Particles } from "../../client/fx.ts";
import type { Rect } from "../../client/render.ts";

/** Every cell the flash particles cover, from the rects they draw (all one-row strips or squares). */
function cells(rects: Rect[]): Set<string> {
  const s = new Set<string>();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s.add(`${x},${y}`);
  return s;
}

describe("explosion flash shape", () => {
  it("a bomb's flash covers a disc: its corners are empty, its centre and edge midpoints are lit", () => {
    const p = new Particles();
    p.explosion(100, 100, 18);
    const out: Rect[] = [];
    p.toRects(out);
    const lit = cells(out);
    // The biggest flash is 22 cells across (radius 11), centred on (100, 100).
    expect(lit.has("100,100")).toBe(true);
    expect(lit.has("110,100")).toBe(true); // right edge midpoint
    expect(lit.has("100,110")).toBe(true); // bottom edge midpoint
    // A 22-cell square would light (110,110); a disc of radius 11 does not (distance 14.1 > 11).
    expect(lit.has("110,110")).toBe(false);
    expect(lit.has("90,90")).toBe(false);
  });
});
