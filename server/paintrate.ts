// Review H2 (8 Nov): a per-address paint budget. The sim bounds one Paint (MAX_PAINT_STROKE) and one tick's paint
// (MAX_PAINT_WORK_PER_TICK), so a flood can no longer freeze clients; but one address could still spend the whole
// per-tick budget and starve every other painter. This charges each Paint what the sim will charge it (stamps times
// the disc's bounding box) against a token bucket per IP tag. Pure: no logging, no clock of its own.

/** Mirrors of the sim's bounds (sim/src/sim.rs MAX_PAINT_RADIUS, sim/src/tuning.rs MAX_PAINT_STROKE). An upper bound is all
 * this needs: the sim also clamps endpoints to the world, which only shortens a stroke. */
export const PAINT_MAX_RADIUS = 32;
export const PAINT_MAX_STROKE = 128;
/** One worst-case stroke: 129 stamps of a 65 x 65 box. */
export const WORST_STROKE = (PAINT_MAX_STROKE + 1) * (2 * PAINT_MAX_RADIUS + 1) ** 2;
/**
 * Cells per second one address may paint: 30 worst-case strokes, what one player dragging the largest brush flat out
 * at the client's 30 sends a second could ever send. A real painter, even at radius 32, moves far less than 128 cells
 * per 33 ms, so a whole classroom behind one NAT painting normally stays well under. Bursts up to two seconds' worth.
 */
export const PAINT_CELLS_PER_SEC = 30 * WORST_STROKE;
export const PAINT_BURST_SECS = 2;

/** The work the sim will do for this Paint payload (mat u8, x0 y0 x1 y1 i16 LE, radius u8), as it charges it. */
export function paintCost(payload: Uint8Array): number {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const [x0, y0, x1, y1] = [v.getInt16(1, true), v.getInt16(3, true), v.getInt16(5, true), v.getInt16(7, true)];
  const r = Math.min(payload[9], PAINT_MAX_RADIUS);
  const stamps = Math.min(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)), PAINT_MAX_STROKE) + 1;
  return stamps * (2 * r + 1) ** 2;
}

/** The most addresses tracked at once (each entry is a few dozen bytes). */
export const MAX_BUCKETS = 4096;

export class PaintRate {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perSec: number;
  private readonly burstSecs: number;
  constructor(perSec = PAINT_CELLS_PER_SEC, burstSecs = PAINT_BURST_SECS) {
    this.perSec = perSec;
    this.burstSecs = burstSecs;
  }

  /** Charge `cost` to `key` at time `nowMs`; false (and nothing charged) when the bucket cannot cover it. */
  take(key: string, cost: number, nowMs: number): boolean {
    const cap = this.perSec * this.burstSecs;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_BUCKETS) {
        this.prune(nowMs);
        // Still full (many keys each spent a little: cold review 1). Evict the oldest-inserted, so the map is truly
        // bounded; an evicted key comes back with a full bucket, which costs at most one burst per eviction.
        if (this.buckets.size >= MAX_BUCKETS) this.buckets.delete(this.buckets.keys().next().value!);
      }
      this.buckets.set(key, (b = { tokens: cap, at: nowMs }));
    }
    b.tokens = Math.min(cap, b.tokens + ((nowMs - b.at) / 1000) * this.perSec);
    b.at = nowMs;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Forget every bucket that would be full by now (an idle address costs nothing to recreate). */
  private prune(nowMs: number): void {
    const cap = this.perSec * this.burstSecs;
    for (const [k, b] of this.buckets) if (b.tokens + ((nowMs - b.at) / 1000) * this.perSec >= cap) this.buckets.delete(k);
  }
}
