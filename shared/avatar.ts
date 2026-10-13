// Avatar constants both sides read (plan 7.6, 8): the client's controller must stay inside the limits
// the server validates Pos inputs against. Units are 1/16 cell, per tick (60 Hz), like the sim's positions.
export const POS_SHIFT = 4;
export const POS_ONE = 1 << POS_SHIFT;

/** Fastest the controller may move on either axis, including terminal fall speed: 3 cells per tick. */
export const MAX_AVATAR_SPEED = 3 * POS_ONE;
/** The strongest knockback impulse (Blast, plan 6.7): 96 units per tick. */
export const MAX_KNOCKBACK_SPEED = 96;
/** Ticks of grace on top of the elapsed ticks, so a batch of delayed Pos inputs is not mistaken for a teleport. */
export const POS_SLACK_TICKS = 10;

/** Largest legal change on one axis between two accepted Pos inputs that are `dtTicks` apart on the server clock. */
export function maxPosJump(dtTicks: number): number {
  return (MAX_AVATAR_SPEED + MAX_KNOCKBACK_SPEED) * (Math.max(0, dtTicks) + POS_SLACK_TICKS);
}

/** Pos payload after the sim's kind and player fields: life u16, x i32, y i32, facing u8. */
export const POS_PAYLOAD_LEN = 11;
/** Cast payload after kind and player: spell u8, angle u16, cast_seq u16. */
export const CAST_PAYLOAD_LEN = 5;

/** Game world size in cells (sim/src/sim.rs GAME_W/GAME_H); the server uses it to bound Pos. */
export const GAME_W = 2048;
export const GAME_H = 1536;

/** What the server remembers of a player's last accepted Pos. */
export interface PosBaseline {
  x: number;
  y: number;
  tick: number;
  life: number;
}

/**
 * Plan 7.6, D-067/D-073: may this Pos follow `last`? Pure, so it is tested directly.
 * - No baseline (first Pos of a process): accepted, the server cannot read the entity's position.
 * - A `life` one above the last accepted one (mod 65536): accepted without a distance check. A respawn teleports the
 *   avatar to the spawn point, and the server never sees the sim's Respawn event; the sim itself ignores any Pos
 *   whose life is not the entity's current one, so a client cannot use a made-up life to teleport (it would be
 *   dropped), and the first Pos with a real new life is still bounded by the world check the caller applies.
 * - Any other life (a stale one, or a skipped one) is held to the distance limit like the same life.
 *   Cost: a client can claim `life + 1` once per claim for a free teleport (the sim drops that Pos), then send
 *   its real life near the claimed spot. Anti-cheat here is light by design (plan 7.6); closing it needs the
 *   server to read `life` from the sim.
 * - Same life: each axis may move at most `maxPosJump(dt)`.
 */
export function posAllowed(last: PosBaseline | undefined, x: number, y: number, life: number, tick: number): boolean {
  if (!last || ((last.life + 1) & 0xffff) === life) return true;
  const limit = maxPosJump(tick - last.tick);
  return Math.abs(x - last.x) <= limit && Math.abs(y - last.y) <= limit;
}
