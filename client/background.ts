// The backdrop is part of the world: the sky/cave-wall line of each column is read ONCE from the pristine generated
// grid (right after `sim.init`, before any replay or snapshot restore) and never recomputed from live cells, so
// snow, ice, a fallen rock or a painted wall above the surface cannot turn into "ground" and digging cannot move it.
// Every client generates the identical world from (seed, cfg), so every client gets the identical line (D-211 draft).
import { MATERIAL_CLASS } from "../shared/names.ts";

/** Wood, Seed, Stem and Flower: trees and plants stand on the ground, they are not it. */
const PLANTS = new Set([6, 7, 8, 9]);
/** Materials that make the ground line: solid terrain, not plants, liquids or gases. */
export const GROUND: readonly boolean[] = MATERIAL_CLASS.map((c, id) => c === "solid" && !PLANTS.has(id));
/** How far either side a shaft looks for its rim, and how far below both rims a column must be to count. */
export const SHAFT_REACH = 64;
export const SHAFT_MIN_DEPTH = 12;

/**
 * Per column, the y of the first cell that starts a run of 3 ground cells (solid terrain only), with generated
 * shafts closed at their rim: a column more than `SHAFT_MIN_DEPTH` below ground on both sides, within
 * `SHAFT_REACH` columns, takes the lower of the two rims, so a generated cave mouth shows cave wall, not sky.
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
  const line = new Uint16Array(w);
  for (let x = 0; x < w; x++) {
    let left = h;
    for (let k = Math.max(0, x - SHAFT_REACH); k < x; k++) left = Math.min(left, raw[k]);
    let right = h;
    for (let k = x + 1; k < Math.min(w, x + SHAFT_REACH + 1); k++) right = Math.min(right, raw[k]);
    const rim = Math.max(left, right);
    line[x] = raw[x] - rim > SHAFT_MIN_DEPTH ? rim : raw[x];
  }
  return line;
}
