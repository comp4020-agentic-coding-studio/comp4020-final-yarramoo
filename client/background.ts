// The backdrop is part of the world: the sky/cave-wall line of each column is read ONCE from the pristine generated
// grid (right after `sim.init`, before any replay or snapshot restore) and never recomputed from live cells, so
// snow, ice, a fallen rock or a painted wall above the surface cannot turn into "ground" and digging cannot move it.
// Every client generates the identical world from (seed, cfg), so every client gets the identical line (D-211 draft).
import { MATERIAL_CLASS } from "../shared/names.ts";

/** Wood, Seed, Stem and Flower: trees and plants stand on the ground, they are not it. Brick (22) is built, not
 * ground: a ruined house or a well's coping on the surface must show sky behind it (content-W1). A mine's Brick lies
 * deep under the surface dirt, so it never starts a column's first run of ground anyway. */
const NOT_GROUND = new Set([6, 7, 8, 9, 22]);
/** Materials that make the ground line: solid terrain, not plants, buildings, liquids or gases. */
export const GROUND: readonly boolean[] = MATERIAL_CLASS.map((c, id) => c === "solid" && !NOT_GROUND.has(id));
/** A shaft is an opening at most this wide (entrance worms are up to 2 x 16 across, plus the funnel at the mouth); a
 * wider dip in the surface is a valley and shows sky. A column must be more than `SHAFT_MIN_DEPTH` below the rim. */
export const SHAFT_MAX_W = 40;
export const SHAFT_MIN_DEPTH = 12;

/**
 * Per column, the y of the first cell that starts a run of 3 ground cells (solid terrain only), with generated
 * shafts closed at their rim, so a generated cave mouth shows cave wall, not sky. Walking up from a column's surface,
 * the open run around it widens; the rim is the highest row at which that run is still at most `SHAFT_MAX_W` wide. A
 * column more than `SHAFT_MIN_DEPTH` below its rim closes the whole run at the rim, so the wall meets the terrain on
 * both sides instead of ending in a step in open air (9 Nov screenshot: the old rule closed only the columns more than
 * 12 below the highest ground within 64 columns either side, leaving a flat block standing in the sky beside a hill).
 * Call it once on the freshly generated grid. `mat` is row-major, `w` by `h`.
 */
export function groundLine(mat: Uint8Array, w: number, h: number): Uint16Array {
  const raw = new Uint16Array(w);
  for (let x = 0; x < w; x++) {
    let y = 0;
    for (; y < h - 2; y++) {
      const i = y * w + x;
      if (GROUND[mat[i]] && GROUND[mat[i + w]] && GROUND[mat[i + 2 * w]]) break;
    }
    raw[x] = y;
  }
  const line = raw.slice();
  for (let x = 0; x < w; x++) {
    // [l, r]: the open run at row y (every column in it is open there); it only widens going up.
    let l = x, r = x, rim = raw[x], rl = x, rr = x;
    for (let y = raw[x] - 1; y >= 0; y--) {
      while (l > 0 && raw[l - 1] > y) l--;
      while (r < w - 1 && raw[r + 1] > y) r++;
      // Too wide, or open to the world's edge (no rim on that side): not a shaft from here up.
      if (r - l + 1 > SHAFT_MAX_W || (l === 0 && raw[0] > y) || (r === w - 1 && raw[w - 1] > y)) break;
      rim = y; rl = l; rr = r;
    }
    if (raw[x] - rim > SHAFT_MIN_DEPTH) for (let k = rl; k <= rr; k++) line[k] = Math.min(line[k], rim);
  }
  return line;
}
