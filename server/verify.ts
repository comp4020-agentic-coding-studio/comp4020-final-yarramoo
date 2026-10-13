// The ONE place the server loads sim.wasm (plan 7.5): restore an uploaded snapshot and hash it.
// It never calls step() or pushInput(): invariant 11 still holds. One instance, reused, about one world of memory.
import { readFileSync } from "node:fs";
import { loadSim, type Sim } from "../shared/sim.ts";

export class SnapshotVerifier {
  private sim: Sim | null = null;
  private readonly bytes: Uint8Array;

  constructor(wasmPath: string) {
    this.bytes = new Uint8Array(readFileSync(wasmPath));
  }

  /** Restore `raw` (canonical snapshot) and return {tick, hash}, or null if the sim refuses it. */
  hashOf(raw: Uint8Array): { tick: number; hash: bigint } | null {
    try {
      this.sim ??= loadSim(this.bytes);
      this.sim.restore(raw);
      return { tick: this.sim.tick(), hash: this.sim.stateHash() };
    } catch {
      return null;
    }
  }
}
