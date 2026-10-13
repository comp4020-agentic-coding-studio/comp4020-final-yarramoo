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
