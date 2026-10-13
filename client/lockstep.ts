// Playout buffer and apply loop (plan 7.1). No DOM, no worker APIs: shared by the worker and the Node tests.
// The sim only ever advances through closed ticks from the server: push that tick's inputs in the listed
// order, then step once. TypeScript writes sim state only through push_input (invariant 1).
import { compressSnapshot, decompressSnapshot, HASH_EVERY, simInputBytes, type TickInput } from "../shared/protocol.ts";
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

  /** Start from a server snapshot: replace the sim state (restore) and expect ticks from snapshot tick + 1. */
  loadSnapshot(compressed: Uint8Array, tick: number): void {
    this.sim.restore(decompressSnapshot(compressed));
    if (this.sim.tick() !== tick) throw new Error(`snapshot tick mismatch: ${this.sim.tick()} vs ${tick}`);
    this.queue.clear();
    this.received = tick;
    if (tick > this.latestClosed) this.latestClosed = tick;
  }

  /** Snapshot the sim now, compressed for upload. Call exactly when sim.tick() is the requested tick. */
  compressedSnapshot(): Uint8Array {
    return compressSnapshot(this.sim.snapshot());
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

/** Reaction to the sim reaching a tick: what the network layer should send. Shared by the worker and the tests. */
export interface TickReactions {
  hash?: bigint;
  snapshot?: { hash: bigint; data: Uint8Array };
}

/**
 * Called after each applied tick. Checkpoint hashes are sent only once live (past the replay target: the server
 * ignores earlier ones), and a requested snapshot is taken exactly at its tick.
 */
export function reactToTick(ls: Lockstep, tick: number, wantSnapshotAt: number): TickReactions {
  const out: TickReactions = {};
  if (tick <= ls.catchUpTarget) return out;
  if (tick % HASH_EVERY === 0) out.hash = ls.sim.stateHash();
  if (tick === wantSnapshotAt) {
    out.snapshot = { hash: out.hash ?? ls.sim.stateHash(), data: ls.compressedSnapshot() };
  }
  return out;
}
