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
}
