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

/**
 * D-078 (supersedes D-073's rule): the server's memory of one player's accepted Pos, one baseline PER LIFE.
 * - A Pos with life L is checked against L's baseline, within `maxPosJump(dt)` per axis.
 * - If L has no baseline, it is accepted with no distance check only when L is the highest known life + 1
 *   (mod 65536), a respawn; that creates L's baseline. The first Pos ever has no baseline at all and is accepted.
 * - A Pos only ever moves the baseline of its own life, so a fake `life + 1` cannot drag the real life's
 *   baseline to a far spot: the real life's next Pos is still measured from where it really was.
 * Only the newest two lives are kept. A made-up life + 1 gets its own harmless baseline (the sim drops that Pos);
 * it can only hurt the cheater, whose real life's baseline is untouched (or, after several claims, pruned, and
 * then rejected).
 */
export class PosBaselines {
  private readonly byLife = new Map<number, { x: number; y: number; tick: number }>();
  private top: number | null = null;

  accept(x: number, y: number, life: number, tick: number): boolean {
    const b = this.byLife.get(life);
    if (b) {
      const limit = maxPosJump(tick - b.tick);
      if (Math.abs(x - b.x) > limit || Math.abs(y - b.y) > limit) return false;
    } else if (this.top !== null && ((this.top + 1) & 0xffff) !== life) {
      return false;
    }
    this.byLife.set(life, { x, y, tick });
    if (!b && (this.top === null || ((this.top + 1) & 0xffff) === life)) this.top = life;
    // Keep the newest two lives.
    for (const k of this.byLife.keys()) if (k !== this.top && k !== ((this.top! - 1) & 0xffff)) this.byLife.delete(k);
    return true;
  }
}

/** Inputs per second the server accepts from one connection (server/main.ts MAX_INPUTS_PER_SEC is set from this). */
export const INPUT_RATE_LIMIT = 40;
/** The client sends a Pos every this many 60 Hz ticks while moving. */
export const POS_SEND_EVERY_TICKS = 2;
/** Headroom under the limit for Join-time bursts and timer jitter. */
export const RATE_MARGIN = 4;
/** Shortest gap between casts so Pos plus casts stay under the limit with the margin (review M4b S3). */
export const CAST_MIN_INTERVAL_MS = Math.ceil(1000 / (INPUT_RATE_LIMIT - RATE_MARGIN - 60 / POS_SEND_EVERY_TICKS));
