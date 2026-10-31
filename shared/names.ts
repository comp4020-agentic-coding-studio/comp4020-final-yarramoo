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
};

/** Spell index to display name. */
export const SPELL_NAMES: readonly string[] = ["Push", "Blast", "Water", "Rose", "Fire", "Bomb", "Dig"];
