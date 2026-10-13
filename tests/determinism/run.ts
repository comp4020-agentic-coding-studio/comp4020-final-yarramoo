// Runner contract: run(simBytes, script, imports?) -> hash log + final chunk hashes.
// Environment-free (no Node APIs) so the browser page can import it.
import { unhex } from "../../shared/inputs.ts";
import { loadSim } from "../../shared/sim.ts";

export interface ScriptLike {
  seed: string;
  world_kind: number;
  ticks: number;
  inputs: Record<string, string[]>;
}

export interface RunResult {
  hashes: [number, string][];
  finalChunkHashes: string[];
}

/** How ticks are grouped into step calls. All must give identical results (D6). */
export type Batching =
  | { kind: "each" }
  | { kind: "batch"; k: number }
  | { kind: "burst"; at: number; len: number };

export interface RunOptions {
  batching?: Batching;
}

const h64 = (n: bigint) => n.toString(16).padStart(16, "0");

export function run(
  simBytes: Uint8Array,
  script: ScriptLike,
  imports: WebAssembly.Imports = {},
  opts: RunOptions = {},
): RunResult {
  const sim = loadSim(simBytes, imports);
  sim.init(BigInt(script.seed), script.world_kind);
  const hashes: [number, string][] = [];
  const b = opts.batching ?? { kind: "each" };

  // Inputs for tick t go in before the step that produces tick t (the queue is
  // per-step, so they cannot be pushed early). Batching groups consecutive
  // (push, step) pairs into one host turn, as a render loop catching up would.
  let t = 1;
  const doTick = () => {
    for (const hx of script.inputs[String(t)] ?? []) sim.pushInput(unhex(hx));
    sim.step();
    // "each" also reads the hash every tick: reading must never perturb state.
    if (b.kind === "each" && t % 60 !== 0) sim.stateHash();
    if (t % 60 === 0) hashes.push([t, h64(sim.stateHash())]);
    t++;
  };
  while (t <= script.ticks) {
    let n = 1;
    if (b.kind === "batch") n = b.k;
    else if (b.kind === "burst") n = t === b.at ? b.len : 1;
    for (let i = 0; i < n && t <= script.ticks; i++) doTick();
  }
  return { hashes, finalChunkHashes: Array.from(sim.chunkHashes(), h64) };
}
