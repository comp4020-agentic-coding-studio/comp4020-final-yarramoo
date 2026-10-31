// Display and prediction data for the spells (plan 6.7). Numbers that mirror sim/src/tuning.rs are checked
// against it by tests/net/spells-table.test.ts, so a balance change cannot silently desync the HUD or the ghost.
import { SPELL_NAMES } from "../shared/names.ts";
import { NUM_SPELLS } from "../shared/sim.ts";

export interface SpellInfo {
  name: string;
  /** Linear 0..1 colour for bolts, trails and bursts. */
  colour: [number, number, number];
  /** Sim values, for the HUD's cooldown bar and the cast-preview ghost. */
  cooldown: number;
  /** Launch speed and gravity in cells per tick (tuning.rs SPEED and GRAVITY_Q8 divided by 256). */
  speed: number;
  gravity: number;
  /** The sim implements it. */
  enabled: boolean;
}

export const SPELLS: SpellInfo[] = [
  { name: SPELL_NAMES[0], colour: [0.75, 0.9, 1], cooldown: 20, speed: 1280 / 256, gravity: 0, enabled: true },
  { name: SPELL_NAMES[1], colour: [1, 0.85, 0.45], cooldown: 90, speed: 0, gravity: 0, enabled: true },
  { name: SPELL_NAMES[2], colour: [0.3, 0.55, 1], cooldown: 10, speed: 768 / 256, gravity: 10 / 256, enabled: true },
  { name: SPELL_NAMES[3], colour: [1, 0.45, 0.7], cooldown: 10, speed: 768 / 256, gravity: 10 / 256, enabled: true },
  { name: SPELL_NAMES[4], colour: [1, 0.55, 0.12], cooldown: 15, speed: 896 / 256, gravity: 4 / 256, enabled: true },
  { name: SPELL_NAMES[5], colour: [0.8, 0.25, 0.25], cooldown: 60, speed: 640 / 256, gravity: 20 / 256, enabled: true },
  { name: SPELL_NAMES[6], colour: [0.7, 0.5, 0.3], cooldown: 18, speed: 0, gravity: 0, enabled: true },
  { name: SPELL_NAMES[7], colour: [0.45, 0.9, 0.2], cooldown: 25, speed: 768 / 256, gravity: 10 / 256, enabled: true },
  { name: SPELL_NAMES[8], colour: [0.35, 0.25, 0.1], cooldown: 20, speed: 768 / 256, gravity: 10 / 256, enabled: true },
  { name: SPELL_NAMES[9], colour: [0.55, 0.55, 0.6], cooldown: 45, speed: 0, gravity: 0, enabled: true },
  { name: SPELL_NAMES[10], colour: [1, 0.35, 0.05], cooldown: 60, speed: 768 / 256, gravity: 10 / 256, enabled: true },
  { name: SPELL_NAMES[11], colour: [0.35, 0.1, 0.6], cooldown: 120, speed: 384 / 256, gravity: 0, enabled: true },
];
if (SPELLS.length !== NUM_SPELLS) throw new Error("spell table out of step with the sim");

/** Spell slots on the bar, in bar order (keys 1-9, then Q/E or the wheel to cycle). */
export const BAR: number[] = [0, 1, 6, 2, 3, 4, 5, 7, 8, 9, 10, 11];
export const INFINITE = 0xffff;

/** Aim angle as the sim wants it: u16, 65536 per turn, 0 along +x, growing towards +y (down the screen). */
export function quantiseAngle(dx: number, dy: number): number {
  const turns = Math.atan2(dy, dx) / (2 * Math.PI);
  return Math.round((turns - Math.floor(turns)) * 65536) & 0xffff;
}

// Sim constants the client mirrors (tests/net/spells-table.test.ts pins each to sim/src/tuning.rs).
/** Ticks a player stays dead before the respawn (tuning.rs DEATH_TICKS). The client only counts down; the sim decides. */
export const DEATH_TICKS = 180;
/** Full health (tuning.rs HEALTH_MAX). */
export const HEALTH_MAX = 100;
/** Bomb blast radius in cells (tuning.rs BOMB_RADIUS); an explosion this big shakes the screen. */
export const BOMB_RADIUS = 18;
/** Dig's capsule: radius and reach in cells (tuning.rs DIG_RADIUS and DIG_REACH). Only the aim preview reads these. */
export const DIG_RADIUS = 7;
export const DIG_REACH = 14;
