// The ONE place the server loads sim.wasm (plan 7.5): restore an uploaded snapshot and hash it, in a worker
// thread so the ~400 ms regeneration of a game world cannot stall the tick clock (D-061). It never calls
// step() or pushInput(): invariant 11 still holds. One worker, reused, about one world of memory.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

/** A restore takes about 400 ms; a job over this is a hung worker (review M4a S3). */
export const VERIFY_TIMEOUT_MS = 10_000;

export interface Verified {
  tick: number;
  hash: bigint;
  rawLength: number;
}

export type CheckResult = { kind: "ok"; v: Verified } | { kind: "refused" } | { kind: "unavailable" };
const UNAVAILABLE: CheckResult = { kind: "unavailable" };

interface Pending {
  resolve: (v: CheckResult) => void;
}

export class SnapshotVerifier {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly bytes: Uint8Array;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly workerUrl: URL;
  /** Workers killed for exceeding the timeout (telemetry and tests). */
  timeouts = 0;

  constructor(wasmPath: string, opts: { timeoutMs?: number; workerUrl?: URL } = {}) {
    this.bytes = new Uint8Array(readFileSync(wasmPath));
    this.timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    this.workerUrl = opts.workerUrl ?? new URL("./verify-worker.ts", import.meta.url);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerUrl, { workerData: { wasm: this.bytes } });
    w.on("message", (m: { id: number; ok: boolean; tick?: number; hash?: bigint; rawLength?: number }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      // The worker answered: either it restored the snapshot, or this build refused it.
      p.resolve(m.ok ? { kind: "ok", v: { tick: m.tick!, hash: m.hash!, rawLength: m.rawLength! } } : { kind: "refused" });
    });
    const dead = () => {
      if (this.worker === w) this.worker = null;
      // A crashed worker fails its outstanding jobs; the next call starts a fresh one.
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.resolve(UNAVAILABLE);
      }
    };
    w.on("error", dead);
    w.on("exit", dead);
    w.unref(); // an idle worker must not keep the process alive
    this.worker = w;
    return w;
  }

  /** Decompress (capped at `maxRaw`), restore and hash. Null if the data is bad or the sim refuses it. */
  hashOf(compressed: Uint8Array, maxRaw: number): Promise<Verified | null> {
    return this.check(compressed, maxRaw).then((r) => (r.kind === "ok" ? r.v : null));
  }

  /**
   * Like `hashOf`, but tells a snapshot this build refuses ("refused": the worker ran and could not restore it)
   * apart from a verification that never finished ("unavailable": timeout, crash, closed). Start-up must only
   * throw a world away for the first: a slow worker on a busy machine is no reason to reset (D-014).
   */
  check(compressed: Uint8Array, maxRaw: number): Promise<CheckResult> {
    if (this.closed) return Promise.resolve(UNAVAILABLE);
    return new Promise((resolve) => {
      const id = this.nextId++;
      const w = this.start();
      // A hung worker never answers and never exits: kill it, fail everything waiting on it (the next call
      // starts a fresh worker), so one stuck job cannot block every later snapshot.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.timeouts++;
        if (this.worker === w) this.worker = null;
        for (const [k, p] of this.pending) {
          this.pending.delete(k);
          p.resolve(UNAVAILABLE);
        }
        void w.terminate();
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)) });
      w.postMessage({ id, data: compressed, maxRaw });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve(UNAVAILABLE);
    }
    await w?.terminate();
  }
}
