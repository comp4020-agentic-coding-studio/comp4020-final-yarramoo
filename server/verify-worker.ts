// Runs in a worker thread (plan 7.5, D-061): decompress, restore and hash an uploaded snapshot, off the
// thread that drives the tick clock. Restore regenerates a game world (about 400 ms), which would otherwise
// stall every closed tick. It restores and hashes ONLY: it never calls step() or pushInput() (invariant 11).
import { parentPort, workerData } from "node:worker_threads";
import { decompressSnapshot } from "../shared/protocol.ts";
import { loadSim, type Sim } from "../shared/sim.ts";

interface Job {
  id: number;
  data: Uint8Array;
  maxRaw: number;
}

let sim: Sim | null = null;
const wasm = workerData.wasm as Uint8Array;

parentPort!.on("message", (job: Job) => {
  try {
    const raw = decompressSnapshot(job.data, job.maxRaw);
    sim ??= loadSim(wasm);
    sim.restore(raw);
    const out = { id: job.id, ok: true, tick: sim.tick(), hash: sim.stateHash(), rawLength: raw.length };
    parentPort!.postMessage(out);
  } catch {
    parentPort!.postMessage({ id: job.id, ok: false });
  }
});
