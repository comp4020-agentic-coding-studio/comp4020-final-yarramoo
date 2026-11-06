// The menu backdrop's world: a local, private Caves sim with real enemies and one explorer (menu redesign, W3).
// Client-only: shared/ has no menu knowledge. The room config below passes the sim's `decode` as it is (no ABI change).
// The seed and the vignettes are CONSTANTS found offline by `tools/menu-vignettes.ts` (invariant 9: nothing read
// from `entities()` at runtime may choose an input), and `tests/net/menu-backdrop.test.ts` fails if a generator
// change empties them.
import type { RoomConfig } from "../../shared/room.ts";

/** Size M (1024 x 768): the worker draws the game frame (mobs, avatars) only when width > 512. `damage: 0`: nothing
 * hurts the explorer. `brushes: 1`: the director may paint. `enemies: 1`: the generator places the mobs. */
export const MENU_BACKDROP: RoomConfig = {
  terrain: 0, size: 1, avatars: 1, damage: 0, spells: 0, brushes: 1, death: 0, respawnSecs: 0, pickupRespawn: 0, round: 0, maxPlayers: 8, enemies: 1,
};

/** The view at 1280 x 800 and scale 3, in cells: what a vignette window is scored and tested at. */
export const WINDOW_W = 427;
export const WINDOW_H = 267;

export interface Vignette {
  /** Where the explorer stands (feet, in cells); the worker teleports its local controller here. */
  x: number;
  y: number;
  /** The camera window's top-left corner, in cells. */
  camX: number;
  camY: number;
}

/** Seed 220: a dawn sky, three windows with 4-8 real mobs and fliers each, no boss within reach (tools/menu-vignettes.ts 1 300). */
export const MENU_SEED = "220";
export const VIGNETTES: Vignette[] = [
  { x: 676, y: 273, camX: 360, camY: 80 }, // 8 mobs, 5 fliers
  { x: 304, y: 281, camX: 144, camY: 80 }, // 8 mobs, 3 fliers
  { x: 700, y: 241, camX: 576, camY: 60 }, // 4 mobs, 2 fliers
];
