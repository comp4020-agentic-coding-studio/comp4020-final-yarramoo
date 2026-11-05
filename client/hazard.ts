// Display-only helpers for hazard feedback (invariant 9: reads outputs, never feeds the sim).
export const LAVA_CELL = 14;
export const HITBOX_W = 5;
export const HITBOX_H = 10;
/** Minimum gap between lava sizzles: the sim hurts every 2nd tick (30 Hz), a sizzle at that rate would be a buzz. */
export const SIZZLE_GAP_MS = 280;

/** Mirrors `Player::hitbox_cells` in sim/src/entities.rs: x, y in 1/16 cell, y is the feet line. True if any lava cell is inside. */
export function hitboxTouchesLava(mat: Uint8Array, w: number, h: number, x16: number, y16: number): boolean {
  const half = (HITBOX_W * 16) / 2;
  const x0 = Math.max(0, (x16 - half) >> 4);
  const x1 = Math.min(w - 1, (x16 + half - 1) >> 4);
  const y0 = Math.max(0, (y16 - HITBOX_H * 16) >> 4);
  const y1 = Math.min(h - 1, (y16 - 1) >> 4);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mat[y * w + x] === LAVA_CELL) return true;
  return false;
}

/** Should a sizzle play: health fell since last frame, a lava cell touches the hitbox, and the last one was long enough ago. */
export function shouldSizzle(prevHealth: number, health: number, touchingLava: boolean, now: number, lastAt: number): boolean {
  return health < prevHealth && health > 0 && touchingLava && now - lastAt >= SIZZLE_GAP_MS;
}
