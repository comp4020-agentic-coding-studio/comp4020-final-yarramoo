// Display-only helpers for hazard feedback (invariant 9: reads outputs, never feeds the sim).
export const LAVA_CELL = 14;
export const FIRE_CELL = 10;
export const ACID_CELL = 16;
export const HITBOX_W = 5;
export const HITBOX_H = 10;
/** Minimum gap between lava sizzles: the sim hurts every 2nd tick (30 Hz), a sizzle at that rate would be a buzz. */
export const SIZZLE_GAP_MS = 280;

/** Mirrors `Player::hitbox_cells` in sim/src/entities.rs: x, y in 1/16 cell, y is the feet line. Which hazard materials are inside. */
export function hitboxMaterials(mat: Uint8Array, w: number, h: number, x16: number, y16: number): { lava: boolean; fire: boolean; acid: boolean } {
  const half = (HITBOX_W * 16) / 2;
  const x0 = Math.max(0, (x16 - half) >> 4);
  const x1 = Math.min(w - 1, (x16 + half - 1) >> 4);
  const y0 = Math.max(0, (y16 - HITBOX_H * 16) >> 4);
  const y1 = Math.min(h - 1, (y16 - 1) >> 4);
  const r = { lava: false, fire: false, acid: false };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const m = mat[y * w + x];
      if (m === LAVA_CELL) r.lava = true;
      else if (m === FIRE_CELL) r.fire = true;
      else if (m === ACID_CELL) r.acid = true;
    }
  return r;
}

export const hitboxTouchesLava = (mat: Uint8Array, w: number, h: number, x16: number, y16: number): boolean => hitboxMaterials(mat, w, h, x16, y16).lava;

/** Should a sizzle play: health fell since last frame, a lava cell touches the hitbox, and the last one was long enough ago. */
export function shouldSizzle(prevHealth: number, health: number, touchingLava: boolean, now: number, lastAt: number): boolean {
  return health < prevHealth && health > 0 && touchingLava && now - lastAt >= SIZZLE_GAP_MS;
}
