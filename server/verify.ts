// The ONE place the server loads sim.wasm (plan 7.5): restore an uploaded snapshot and hash it, in a worker
// thread so the ~400 ms regeneration of a game world cannot stall the tick clock (D-061). It never calls
// step() or pushInput(): invariant 11 still holds. One worker, reused, about one world of memory.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

export interface Verified {
  tick: number;
  hash: bigint;
  rawLength: number;
}

interface Pending {
  resolve: (v: Verified | null) => void;
}

export class SnapshotVerifier {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly bytes: Uint8Array;
  private closed = false;

  constructor(wasmPath: string) {
    this.bytes = new Uint8Array(readFileSync(wasmPath));
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./verify-worker.ts", import.meta.url), { workerData: { wasm: this.bytes } });
    w.on("message", (m: { id: number; ok: boolean; tick?: number; hash?: bigint; rawLength?: number }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      p.resolve(m.ok ? { tick: m.tick!, hash: m.hash!, rawLength: m.rawLength! } : null);
    });
    const dead = () => {
      if (this.worker === w) this.worker = null;
      // A crashed worker fails its outstanding jobs; the next call starts a fresh one.
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.resolve(null);
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
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve });
      this.start().postMessage({ id, data: compressed, maxRaw });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve(null);
    }
    await w?.terminate();
  }
}
