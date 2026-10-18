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
    const r = this.check(raw);
    return r.kind === "ok" ? r.v : null;
  }

  /**
   * Like `hashOf`, but tells a snapshot the sim refuses ("refused") apart from a verifier that could not run at all
   * ("unavailable": the wasm failed to load, for example out of memory on the 256 MB machine). Start-up may only
   * throw a world away for the first (D-014; ported from D-112 on `multa`).
   */
  check(raw: Uint8Array): { kind: "ok"; v: { tick: number; hash: bigint } } | { kind: "refused" } | { kind: "unavailable" } {
    try {
      this.sim ??= loadSim(this.bytes);
    } catch {
      return { kind: "unavailable" };
    }
    try {
      this.sim.restore(raw);
      return { kind: "ok", v: { tick: this.sim.tick(), hash: this.sim.stateHash() } };
    } catch {
      return { kind: "refused" };
    }
  }
}
