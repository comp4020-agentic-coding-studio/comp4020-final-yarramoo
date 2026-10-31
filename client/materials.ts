import { MATERIAL_NAMES } from "../shared/names.ts";

// Display data for the material palette (names and swatch colours). Ids match sim/src/materials.rs.
export interface MaterialInfo {
  id: number;
  name: string;
  /** Swatch and shader base colour, 0xRRGGBB. */
  color: number;
}

export const MATERIALS: MaterialInfo[] = [
  { id: 4, name: MATERIAL_NAMES[4], color: 0xdcc178 },
  { id: 5, name: MATERIAL_NAMES[5], color: 0x3a74d8 },
  { id: 3, name: MATERIAL_NAMES[3], color: 0x5a3a24 },
  { id: 2, name: MATERIAL_NAMES[2], color: 0x7d8087 },
  { id: 6, name: MATERIAL_NAMES[6], color: 0xb8803c },
  { id: 7, name: MATERIAL_NAMES[7], color: 0xe8e060 },
  { id: 8, name: MATERIAL_NAMES[8], color: 0x3f9a3a },
  { id: 9, name: MATERIAL_NAMES[9], color: 0xe2478a },
  { id: 10, name: MATERIAL_NAMES[10], color: 0xff7a1c },
  { id: 11, name: MATERIAL_NAMES[11], color: 0x6e7078 },
  { id: 12, name: MATERIAL_NAMES[12], color: 0xcfd8e6 },
  { id: 13, name: MATERIAL_NAMES[13], color: 0x2e2e36 },
  { id: 14, name: MATERIAL_NAMES[14], color: 0xe03c14 },
  { id: 15, name: MATERIAL_NAMES[15], color: 0x6b4a14 },
  { id: 16, name: MATERIAL_NAMES[16], color: 0x8ad21c },
  { id: 17, name: MATERIAL_NAMES[17], color: 0xb4c85a },
  { id: 0, name: MATERIAL_NAMES[0], color: 0x0b0e14 },
];

/** Colour for every id 0..15 (unused ids are magenta so a bug is visible). */
export function paletteTable(): number[] {
  const t = new Array<number>(16).fill(0xff00ff);
  t[1] = 0x2b2d33; // Bedrock: not paintable, so not in MATERIALS
  for (const m of MATERIALS) t[m.id] = m.color;
  return t;
}

/** Sandbox size. Other worlds report their size through `sim.width()/height()`. */
export const SANDBOX = 512;
/** What the camera shows of a world larger than the sandbox (plan 8). */
export const GAME_VIEW = { w: 480, h: 270 };
/** Depth bands of the game world: one source in shared/stats.ts, pinned to sim/src/gen.rs. */
export { DEEP_TOP, SHALLOW_TOP } from "../shared/stats.ts";
