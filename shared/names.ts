// The one list of material and spell names (ids match sim/src/materials.rs and sim/src/tuning.rs). Data only, no
// imports: the server's runtime image has no client/ directory, and the client imports these for its tables.

/** Material id to display name. Id 1 is Bedrock (not paintable). */
export const MATERIAL_NAMES: Readonly<Record<number, string>> = {
  0: "Erase",
  1: "Bedrock",
  2: "Rock",
  3: "Dirt",
  4: "Sand",
  5: "Water",
  6: "Wood",
  7: "Seed",
  8: "Stem",
  9: "Flower",
  10: "Fire",
  11: "Smoke",
  12: "Steam",
  13: "Gunpowder",
  14: "Lava",
  15: "Oil",
  16: "Acid",
  17: "Gas",
  18: "Ice",
  19: "Glass",
  20: "Coal",
  21: "Pebbles",
  22: "Brick",
  23: "Moss",
  24: "Mushroom",
  25: "Mud",
  26: "Salt",
  27: "Snow",
  28: "Thermite",
};

/** Mirrors `sim/src/materials.rs` `paintable`: Paint may place Erase (0), Rock to Seed (2-7), Fire to Coal (10-20), Brick to Mushroom (22-24) and Mud to Thermite (25-28);
 * never Bedrock, Stem, Flower or Pebbles. The server counts paint stats only for these (hardening review server F1). */
export const isPaintable = (m: number): boolean => m === 0 || (m >= 2 && m <= 7) || (m >= 10 && m <= 20) || (m >= 22 && m <= 28);

/** Spell index to display name. */
export const SPELL_NAMES: readonly string[] = ["Push", "Blast", "Water", "Rose", "Fire", "Bomb", "Dig", "Acid Flask", "Oil Flask", "Wall", "Lava Flask", "Black Hole", "Freeze", "Quake", "Mudslide"];

/**
 * How the avatar controller treats each material id (one list, so a new material is one line). "gas" never
 * blocks, "liquid" never blocks but slows and lets you swim, "solid" blocks. Index = material id. An id past
 * the end counts as solid (the safe default for a wall).
 */
export type MaterialClass = "empty" | "solid" | "liquid" | "gas";
export const MATERIAL_CLASS: readonly MaterialClass[] = [
  "empty", // 0
  "solid", // 1 Bedrock
  "solid", // 2 Rock
  "solid", // 3 Dirt
  "solid", // 4 Sand
  "liquid", // 5 Water
  "solid", // 6 Wood
  "solid", // 7 Seed
  "solid", // 8 Stem
  "solid", // 9 Flower
  "gas", // 10 Fire
  "gas", // 11 Smoke
  "gas", // 12 Steam
  "solid", // 13 Gunpowder
  "liquid", // 14 Lava
  "liquid", // 15 Oil
  "liquid", // 16 Acid
  "gas", // 17 Gas
  "solid", // 18 Ice
  "solid", // 19 Glass
  "solid", // 20 Coal
  "solid", // 21 Pebbles
  "solid", // 22 Brick
  "solid", // 23 Moss
  "solid", // 24 Mushroom
  "solid", // 25 Mud
  "solid", // 26 Salt
  "solid", // 27 Snow
  "solid", // 28 Thermite
];
