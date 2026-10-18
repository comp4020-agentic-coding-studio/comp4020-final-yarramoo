// Playout buffer and apply loop (plan 7.1). No DOM, no worker APIs: shared by the worker and the Node tests.
// The sim only ever advances through closed ticks from the server: push that tick's inputs in the listed
// order, then step once. TypeScript writes sim state only through push_input (invariant 1).
import { compressSnapshot, decompressSnapshot, HASH_EVERY, maxSnapshotRawFor, simInputBytes, WORLD_GAME, WORLD_SANDBOX, type TickInput } from "../shared/protocol.ts";
import type { Sim } from "../shared/sim.ts";

/** Review M4b S2: a Knock older than this many ticks behind the live edge is dropped (a stalled tab's backlog). */
export const KNOCK_FRESH_TICKS = 6;
/** The sim never moves anyone for a Knock, so skipping a stale one desyncs nothing; it only avoids a fling. */
export const knockIsFresh = (tick: number, latestClosed: number): boolean => tick >= latestClosed - KNOCK_FRESH_TICKS;

/** Checkpoints of per-chunk hashes a client keeps for a desync diagnosis (plan 6.10, D-126). About 30 KB in the game world. */
export const CHUNK_RING = 5;

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
  /** Chunk hashes at the last CHUNK_RING checkpoints this client hashed, oldest first. Read-only diagnostics (invariant 9). */
  private readonly chunkRing: { tick: number; hashes: BigUint64Array }[] = [];

  constructor(sim: Sim) {
    this.sim = sim;
  }

  /** Keep the sim's per-chunk hashes for `tick` (call right after `stateHash`, which has just refreshed them). */
  recordChunkHashes(tick: number): void {
    this.chunkRing.push({ tick, hashes: this.sim.chunkHashes() });
    while (this.chunkRing.length > CHUNK_RING) this.chunkRing.shift();
  }

  /** The chunk hashes recorded for `tick`, or null when it has left the ring (or was never hashed here). */
  chunkHashesAt(tick: number): BigUint64Array | null {
    return this.chunkRing.find((e) => e.tick === tick)?.hashes ?? null;
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
    // The world's size (set by init before any snapshot arrives) tells which ceiling applies.
    const kind = this.sim.width() * this.sim.height() > 512 * 512 ? WORLD_GAME : WORLD_SANDBOX;
    this.sim.restore(decompressSnapshot(compressed, maxSnapshotRawFor(kind)));
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
  if (tick % HASH_EVERY === 0) {
    out.hash = ls.sim.stateHash();
    ls.recordChunkHashes(tick);
  }
  if (tick === wantSnapshotAt) {
    out.snapshot = { hash: out.hash ?? ls.sim.stateHash(), data: ls.compressedSnapshot() };
  }
  return out;
}
