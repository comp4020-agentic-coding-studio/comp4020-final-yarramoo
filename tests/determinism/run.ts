// Runner contract: run(simBytes, script, imports?) -> hash log + final chunk hashes.
// Environment-free (no Node APIs) so the browser page can import it.
import { unhex } from "../../shared/inputs.ts";
import { CAVES_PVP, CLASSIC_SANDBOX, configForKind, encodeConfig, type RoomConfig } from "../../shared/room.ts";
import { loadSim } from "../../shared/sim.ts";

const PRESETS: Record<string, RoomConfig> = { classic_sandbox: CLASSIC_SANDBOX, caves_pvp: CAVES_PVP };
import type { SimEvent } from "../../shared/sim.ts";

export interface ScriptLike {
  seed: string;
  /** Legacy alias: 0 is classic_sandbox, 1 is caves_pvp. */
  world_kind?: number;
  /** "classic_sandbox" | "caves_pvp"; wins over world_kind. */
  config?: string;
  ticks: number;
  inputs: Record<string, string[]>;
}

export interface RunResult {
  hashes: [number, string][];
  finalChunkHashes: string[];
  /** Every event of every step, in order, when `RunOptions.collectEvents` is set (tick added). */
  events?: (SimEvent & { tick: number })[];
}

/** How ticks are grouped into step calls. All must give identical results (D6). */
export type Batching =
  | { kind: "each" }
  | { kind: "batch"; k: number }
  | { kind: "burst"; at: number; len: number };

export interface RunOptions {
  batching?: Batching;
  /** D7: switch chunk sleeping on or off before the first step (default: the sim's own default, on). */
  sleep?: boolean;
  /** D8: also record the state hash straight after init, as tick 0. */
  hashTick0?: boolean;
  /** M5: keep every event so a test can assert the script really exercised damage, death and bags. */
  collectEvents?: boolean;
}

/** The room config bytes a script asks for: a preset name in `config`, else the `world_kind` alias (0 or 1). */
export function scriptConfig(script: Pick<ScriptLike, "world_kind" | "config">): Uint8Array {
  if (script.config !== undefined) {
    const c = PRESETS[script.config];
    if (!c) throw new Error(`unknown script config ${script.config}`);
    return encodeConfig(c);
  }
  return configForKind(script.world_kind ?? -1);
}

const h64 = (n: bigint) => n.toString(16).padStart(16, "0");

export function run(
  simBytes: Uint8Array,
  script: ScriptLike,
  imports: WebAssembly.Imports = {},
  opts: RunOptions = {},
): RunResult {
  const sim = loadSim(simBytes, imports);
  sim.init(BigInt(script.seed), scriptConfig(script));
  if (opts.sleep !== undefined) sim.setSleepEnabled(opts.sleep);
  const hashes: [number, string][] = [];
  if (opts.hashTick0) hashes.push([0, h64(sim.stateHash())]);
  const events: (SimEvent & { tick: number })[] = [];
  const b = opts.batching ?? { kind: "each" };

  // Inputs for tick t go in before the step that produces tick t (the queue is
  // per-step, so they cannot be pushed early). Batching groups consecutive
  // (push, step) pairs into one host turn, as a render loop catching up would.
  let t = 1;
  const doTick = () => {
    for (const hx of script.inputs[String(t)] ?? []) sim.pushInput(unhex(hx));
    sim.step();
    if (opts.collectEvents) for (const e of sim.events()) events.push({ ...e, tick: t });
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
  const out: RunResult = { hashes, finalChunkHashes: Array.from(sim.chunkHashes(), h64) };
  if (opts.collectEvents) out.events = events;
  return out;
}
