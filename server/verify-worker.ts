// Runs in a worker thread (plan 7.5, D-061): decompress, restore and hash an uploaded snapshot, off the
// thread that drives the tick clock. Restore regenerates a game world (about 400 ms at M on a full core, 35-50 s at L on
// the Fly quota) unless this instance last generated the same seed and config (D-088), which is why each room keeps its
// own worker (D-228). It restores, generates and hashes ONLY: it never calls step() or pushInput() (invariant 11).
import { parentPort, workerData } from "node:worker_threads";
import { decompressSnapshot } from "../shared/protocol.ts";
import { loadSim, type Sim } from "../shared/sim.ts";

interface Job {
  id: number;
  data: Uint8Array;
  maxRaw: number;
}
/** Generate a room's world from the server's own seed and config, so the room's verifies find its base cached. */
interface Prewarm {
  prewarm: true;
  seed: bigint;
  cfg: Uint8Array;
}

let sim: Sim | null = null;
const wasm = workerData.wasm as Uint8Array;
/** Seed and config (snapshot header bytes 38..62, sim/src/snapshot.rs) of the world this instance holds a base for.
 *  Telemetry only, to say whether a restore was cold: the sim itself decides whether its base matches. */
let cached: string | null = null;
/** A lane's room (set by its prewarm): every snapshot it verifies must carry this seed and config. Null on the overflow worker. */
let room: string | null = null;
const SEED_AT = 38;
const CFG_END = SEED_AT + 8 + 16;
const keyOf = (raw: Uint8Array) => (raw.length >= CFG_END ? Buffer.from(raw.subarray(SEED_AT, CFG_END)).toString("hex") : null);

parentPort!.on("message", (job: Job | Prewarm) => {
  if ("prewarm" in job) {
    try {
      sim ??= loadSim(wasm);
      sim.init(job.seed, job.cfg);
      const seed = Buffer.alloc(8);
      seed.writeBigUInt64LE(BigInt.asUintN(64, job.seed));
      room = Buffer.concat([seed, job.cfg]).toString("hex");
      cached = room;
    } catch {
      // A config this build refuses: the room's verifies will say so themselves. The lane still verifies only its own
      // room's seed and config (review S3: a failed prewarm must not drop the guard).
      const seed = Buffer.alloc(8);
      seed.writeBigUInt64LE(BigInt.asUintN(64, job.seed));
      room = Buffer.concat([seed, job.cfg]).toString("hex");
      cached = null;
    }
    parentPort!.postMessage({ warmed: true });
    return;
  }
  // Which stage failed goes back with the refusal, so `snapshot.rejected` can say why (ship check 5 Nov: every upload
  // was refused in the image, and one reason string covered a bad frame, a sim refusal and a timeout alike).
  let stage = "decompress";
  try {
    const raw = decompressSnapshot(job.data, job.maxRaw);
    stage = "restore";
    sim ??= loadSim(wasm);
    const key = keyOf(raw);
    // A lane verifies one room: a snapshot of another world is refused before it can make the lane regenerate (a hostile
    // uploader could otherwise turn every verify of the room cold). An honest snapshot always has the room's own.
    if (room !== null && key !== room) throw new Error("snapshot seed or config differs from the room's");
    const cold = key === null || key !== cached;
    sim.restore(raw);
    cached = key; // restore keeps the base it matched or generated (sim/src/lib.rs restore)
    const out = { id: job.id, ok: true, tick: sim.tick(), hash: sim.stateHash(), rawLength: raw.length, cold };
    parentPort!.postMessage(out);
  } catch (e) {
    // A refused restore leaves the previous world and its base in place (sim/src/lib.rs restore), so `cached` stands.
    parentPort!.postMessage({ id: job.id, ok: false, stage, error: String((e as Error)?.message ?? e).slice(0, 120) });
  }
});
