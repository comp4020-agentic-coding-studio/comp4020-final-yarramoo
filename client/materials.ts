// Display data for the material palette (names and swatch colours). Ids match sim/src/materials.rs.
export interface MaterialInfo {
  id: number;
  name: string;
  /** Swatch and shader base colour, 0xRRGGBB. */
  color: number;
}

export const MATERIALS: MaterialInfo[] = [
  { id: 4, name: "Sand", color: 0xdcc178 },
  { id: 5, name: "Water", color: 0x3a74d8 },
  { id: 3, name: "Dirt", color: 0x5a3a24 },
  { id: 2, name: "Rock", color: 0x7d8087 },
  { id: 6, name: "Wood", color: 0xb8803c },
  { id: 7, name: "Seed", color: 0xe8e060 },
  { id: 8, name: "Stem", color: 0x3f9a3a },
  { id: 9, name: "Flower", color: 0xe2478a },
  { id: 10, name: "Fire", color: 0xff7a1c },
  { id: 11, name: "Smoke", color: 0x6e7078 },
  { id: 12, name: "Steam", color: 0xcfd8e6 },
  { id: 13, name: "Gunpowder", color: 0x2e2e36 },
  { id: 14, name: "Lava", color: 0xe03c14 },
  { id: 0, name: "Erase", color: 0x0b0e14 },
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
