// Tick clock and input sequencer (plan 7.1). Pure given an injected time source: no timers in here.
// Ticks are numbered from 1: closed tick k is applied by "push its inputs, then step", leaving sim.tick() == k.
import type { TickInput } from "../shared/protocol.ts";

export interface ClosedTick {
  tick: number;
  inputs: TickInput[];
}

export class TickClock {
  private readonly now: () => number;
  private readonly hz: number;
  private t0 = 0;
  private baseTick = 0;
  private paused = true;
  /** Highest tick already closed (and handed to onClose). */
  private closed = 0;
  private open: TickInput[] = [];
  private readonly onClose: (t: ClosedTick) => void;

  constructor(now: () => number, onClose: (t: ClosedTick) => void, hz = 60) {
    this.now = now;
    this.onClose = onClose;
    this.hz = hz;
  }

  get lastClosed(): number {
    return this.closed;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** c(t) = floor((t - t0) * hz / 1000) + base_tick. */
  private reading(): number {
    return Math.floor(((this.now() - this.t0) * this.hz) / 1000) + this.baseTick;
  }

  /** Cold start: numbering continues from a restored world's last tick. Only valid before the first resume. */
  setClosed(tick: number): void {
    this.closed = tick;
  }

  /** Admin reset: forget everything, including inputs stamped but not yet closed. Pauses without advancing, so no tick closes on the way. */
  reset(): void {
    this.paused = true;
    this.open = [];
    this.closed = 0;
    this.baseTick = 0;
  }

  /** Shutdown only: close whatever is open right now, even mid-tick, so nothing stamped is lost. */
  closeNow(): void {
    this.advance();
    if (this.open.length === 0) return;
    this.closed++;
    const inputs = this.open;
    this.open = [];
    this.onClose({ tick: this.closed, inputs });
  }

  /** Re-base t0 so numbering continues from the last closed tick. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.t0 = this.now();
    this.baseTick = this.closed;
  }

  pause(): void {
    if (this.paused) return;
    this.advance();
    this.paused = true;
  }

  /** Close every tick the clock has passed, in order, so a late timer never skips one. */
  advance(): void {
    if (this.paused) return;
    const c = this.reading();
    while (this.closed < c) {
      this.closed++;
      const inputs = this.open;
      this.open = [];
      this.onClose({ tick: this.closed, inputs });
    }
  }

  /** An input arriving while the clock reads c goes to open tick c + 1, in arrival order. Returns that tick. */
  stamp(input: TickInput): number {
    this.advance();
    this.open.push(input);
    return this.closed + 1;
  }

  /** Inputs already in the open tick. */
  get openCount(): number {
    return this.open.length;
  }
}

/**
 * Most client inputs one tick may carry. The TICK frame stores its input count as a u16, so a tick past 65535
 * inputs would encode a wrapped count, every client would misparse it, and the frame is persisted. Normal play is a
 * few per tick (64 members at 40/s over 60 ticks/s); this backstop sits far above that (review catch-up N1).
 * Server-stamped Join and Leave are not capped, so `encodeTick` keeps its own hard check too.
 */
export const MAX_CLIENT_INPUTS_PER_TICK = 4096;
