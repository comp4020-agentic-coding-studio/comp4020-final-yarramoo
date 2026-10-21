// The room config table (plan-game-modes.md "Config fields"): field names, ranges, and the 16-byte encoding,
// byte-identical with sim/src/config.rs (tests/net/room.test.ts and sim/tests/config.rs share their vectors).
// The server validates a config here before it creates a room; the sim validates again at init.

export const CONFIG_BYTES = 16;
export const CONFIG_VERSION = 1;

export interface RoomConfig {
  /** 0 Caves, 1 Solid box, 2 Empty box. */
  terrain: number;
  /** 0 S, 1 M, 2 L. */
  size: number;
  avatars: number;
  /** 0 none, 1 environment only, 2 full PvP. */
  damage: number;
  /** 0 from pickups, 1 all spells, unlimited. */
  spells: number;
  brushes: number;
  /** 0 respawn, 1 out until the round ends. */
  death: number;
  respawnSecs: number;
  pickupRespawn: number;
  /** 0 none, 1 last player standing (needs death 1). */
  round: number;
  maxPlayers: number;
}

/** Wire order of the fields after the version byte, with their inclusive ranges. */
export const CONFIG_FIELDS: readonly { key: keyof RoomConfig; min: number; max: number }[] = [
  { key: "terrain", min: 0, max: 2 },
  { key: "size", min: 0, max: 2 },
  { key: "avatars", min: 0, max: 1 },
  { key: "damage", min: 0, max: 2 },
  { key: "spells", min: 0, max: 1 },
  { key: "brushes", min: 0, max: 1 },
  { key: "death", min: 0, max: 1 },
  { key: "respawnSecs", min: 0, max: 30 },
  { key: "pickupRespawn", min: 0, max: 1 },
  { key: "round", min: 0, max: 1 },
  { key: "maxPlayers", min: 2, max: 8 },
];

/** World size in cells by `size`. S is 512x512 for now (see sim/src/config.rs). */
export const SIZE_DIMS: readonly (readonly [number, number])[] = [
  [512, 512],
  [1024, 768],
  [2048, 1536],
];

/** Today's world 0. */
export const CLASSIC_SANDBOX: RoomConfig = {
  terrain: 2, size: 0, avatars: 0, damage: 0, spells: 0, brushes: 1, death: 0, respawnSecs: 0, pickupRespawn: 0, round: 0, maxPlayers: 8,
};
/** Today's world 1. */
export const CAVES_PVP: RoomConfig = {
  terrain: 0, size: 2, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 0, respawnSecs: 3, pickupRespawn: 1, round: 0, maxPlayers: 8,
};

export function encodeConfig(c: RoomConfig): Uint8Array {
  const b = new Uint8Array(CONFIG_BYTES);
  b[0] = CONFIG_VERSION;
  CONFIG_FIELDS.forEach((f, i) => {
    b[1 + i] = c[f.key];
  });
  return b;
}

/** null for a wrong length or version, a non-zero reserved byte, or any out-of-range field (nothing is clamped). */
export function decodeConfig(b: Uint8Array): RoomConfig | null {
  if (b.length !== CONFIG_BYTES || b[0] !== CONFIG_VERSION) return null;
  for (let i = 12; i < CONFIG_BYTES; i++) if (b[i] !== 0) return null;
  const c: Record<string, number> = {};
  for (let i = 0; i < CONFIG_FIELDS.length; i++) {
    const f = CONFIG_FIELDS[i];
    const v = b[1 + i];
    if (v < f.min || v > f.max) return null;
    c[f.key] = v;
  }
  const cfg = c as unknown as RoomConfig;
  if (cfg.round === 1 && cfg.death !== 1) return null;
  return cfg;
}

export const isCaves = (c: RoomConfig): boolean => c.terrain === 0;
