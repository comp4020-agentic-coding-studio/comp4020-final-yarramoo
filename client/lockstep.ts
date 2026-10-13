// Playout buffer and apply loop (plan 7.1). No DOM, no worker APIs: shared by the worker and the Node tests.
// The sim only ever advances through closed ticks from the server: push that tick's inputs in the listed
// order, then step once. TypeScript writes sim state only through push_input (invariant 1).
import { simInputBytes, type TickInput } from "../shared/protocol.ts";
import type { Sim } from "../shared/sim.ts";

/** Target buffer depth, in ticks. */
export const J = 2;
export const MAX_EXTRA = 4;

export class Lockstep {
  readonly sim: Sim;
  private readonly queue = new Map<number, TickInput[]>();
  private received = 0;
  /** Latest closed tick the server has told us about (WELCOME, then every TICK). */
  latestClosed = 0;
  /** Replay target from WELCOME: until sim.tick() reaches it we are fast-forwarding. */
  catchUpTarget = 0;
  /** True while playing live; drops to false when the buffer runs dry, back to true once J ticks are queued. */
  private playing = false;
  onStepped: ((tick: number, inputs: TickInput[]) => void) | null = null;

  constructor(sim: Sim) {
    this.sim = sim;
  }

  get simTick(): number {
    return this.sim.tick();
  }

  get buffered(): number {
    return this.received - this.sim.tick();
  }

  get fastForwarding(): boolean {
    return this.sim.tick() < this.catchUpTarget;
  }

  /** 0..1 progress of the initial replay. */
  get progress(): number {
    return this.catchUpTarget === 0 ? 1 : Math.min(1, this.sim.tick() / this.catchUpTarget);
  }

  /** Accept a closed tick. Ticks must arrive contiguously from 1; a gap is a protocol error. */
  push(tick: number, inputs: TickInput[]): void {
    if (tick !== this.received + 1) throw new Error(`tick gap: expected ${this.received + 1}, got ${tick}`);
    this.received = tick;
    if (tick > this.latestClosed) this.latestClosed = tick;
    this.queue.set(tick, inputs);
  }

  /** Apply the next buffered tick. Returns false if there is none. */
  stepOne(): boolean {
    const next = this.sim.tick() + 1;
    const inputs = this.queue.get(next);
    if (!inputs) return false;
    this.queue.delete(next);
    for (const i of inputs) this.sim.pushInput(simInputBytes(i));
    this.sim.step();
    this.onStepped?.(next, inputs);
    return true;
  }

  /** How many ticks to step this frame, given `base` due from the 60 Hz accumulator. */
  plan(base: number): number {
    const buf = this.buffered;
    if (buf <= 0) {
      this.playing = false; // hold when empty, and rebuffer to J before resuming
      return 0;
    }
    if (!this.playing) {
      if (buf < J) return 0;
      this.playing = true;
    }
    let n = base;
    if (buf > J + 4) n += Math.min(MAX_EXTRA, buf - J);
    return Math.min(n, buf);
  }

  /** Run up to `n` steps. Returns how many ran. */
  run(n: number): number {
    let k = 0;
    while (k < n && this.stepOne()) k++;
    return k;
  }

  /** Fast-forward through the replay for at most `budgetMs`, returning when done or out of time. */
  fastForward(budgetMs: number, now: () => number = () => performance.now()): void {
    const end = now() + budgetMs;
    while (this.fastForwarding && now() < end) {
      if (!this.stepOne()) return;
    }
  }
}
