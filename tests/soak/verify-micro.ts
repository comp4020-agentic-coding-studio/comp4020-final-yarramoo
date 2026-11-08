// Capacity 7 Nov: time the server verify worker's exact job (server/verify-worker.ts: decompressSnapshot, restore,
// stateHash) per preset and size, cold (a different seed than the last restore, so restore regenerates the world)
// and warm (same seed: the D-088 base hit), for a generated snapshot and a worst-case one (every chunk present).
// Run inside the real image so a Docker --cpus limit applies:
//   docker run --rm --cpus=0.0625 --memory=256m -v /tmp/wt-cap/tests/soak:/app/tests/soak:ro cap-app:9cfd24f \
//     node tests/soak/verify-micro.ts
// Env: REPS (default 3), SIZES (default "0,1,2"), OUT (JSON path, default stdout only).
import { readFileSync, writeFileSync } from "node:fs";
import { compressSnapshot, decompressSnapshot, maxSnapshotRawFor } from "../../shared/protocol.ts";
import { CAVES_PVP, SURVIVAL, encodeConfig, type RoomConfig } from "../../shared/room.ts";
import { loadSim } from "../../shared/sim.ts";

const wasm = new Uint8Array(readFileSync(new URL("../../sim/target/wasm32-unknown-unknown/release/sim.wasm", import.meta.url)));
const REPS = Number(process.env.REPS ?? 3);
const SIZES = (process.env.SIZES ?? "0,1,2").split(",").map(Number);
const DEATHMATCH: RoomConfig = { ...CAVES_PVP, size: 1 }; // client/menu/screens.ts DEATHMATCH, size varied below
const presets: { name: string; cfg: RoomConfig }[] = [
  { name: "survival", cfg: SURVIVAL },
  { name: "deathmatch", cfg: DEATHMATCH },
];
const CHUNK = 64;

/** Rebuild a raw snapshot with every chunk present (the largest restore input), from the generated planes. */
function everyChunk(raw: Uint8Array, mat: Uint8Array, aux: Uint8Array, w: number, h: number): Uint8Array {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const HEADER = 70;
  const elen = dv.getUint32(HEADER, true);
  const eend = HEADER + 4 + elen;
  const n = dv.getUint32(eend, true);
  const rec = 2 + 2 * CHUNK * CHUNK;
  const tailAt = eend + 4 + n * rec; // falls (u8 + 4 each) then woken bitset
  const tail = raw.subarray(tailAt);
  const cw = w / CHUNK;
  const ch = h / CHUNK;
  const total = cw * ch;
  const out = new Uint8Array(eend + 4 + total * rec + tail.length);
  out.set(raw.subarray(0, eend));
  const ov = new DataView(out.buffer);
  ov.setUint32(eend, total, true);
  let o = eend + 4;
  for (let c = 0; c < total; c++) {
    ov.setUint16(o, c, true);
    o += 2;
    const cx = c % cw;
    const cy = Math.floor(c / cw);
    for (const plane of [mat, aux]) {
      for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) {
        out.set(plane.subarray(y * w + cx * CHUNK, y * w + cx * CHUNK + CHUNK), o);
        o += CHUNK;
      }
    }
  }
  out.set(tail, o);
  return out;
}

const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const results: Record<string, unknown>[] = [];
for (const p of presets) {
  for (const size of SIZES) {
    const cfg = { ...p.cfg, size };
    const cfgB = encodeConfig(cfg);
    const maxRaw = maxSnapshotRawFor(cfg);
    // Two worlds of this config, different seeds; the client-side init cost is generation.
    const snaps: { seed: bigint; gen: Uint8Array; full: Uint8Array; initMs: number }[] = [];
    for (const seed of [11n, 22n]) {
      const s = loadSim(wasm);
      const t = performance.now();
      s.init(seed, cfgB);
      const initMs = ms(t);
      for (let i = 0; i < 60; i++) s.step();
      const raw = s.snapshot();
      const full = everyChunk(raw, s.matView(), s.auxView(), s.width(), s.height());
      snaps.push({ seed, gen: compressSnapshot(raw), full: compressSnapshot(full), initMs });
    }
    // The verify worker: ONE sim instance reused across jobs (verify-worker.ts `sim ??= loadSim`).
    const worker = loadSim(wasm);
    let lastIdx = -1; // seed index the worker restored last; a cold job must use the other one
    const job = (data: Uint8Array) => {
      const t = performance.now();
      const raw = decompressSnapshot(data, maxRaw);
      const tD = ms(t);
      worker.restore(raw);
      worker.stateHash();
      return { totalMs: ms(t), decompressMs: tD };
    };
    for (const kind of ["gen", "full"] as const) {
      const cold: unknown[] = [];
      const warm: unknown[] = [];
      for (let r = 0; r < REPS; r++) {
        lastIdx = lastIdx === 0 ? 1 : 0; // the other seed than the last restore: this job regenerates
        cold.push(job(snaps[lastIdx][kind]));
      }
      for (let r = 0; r < REPS; r++) warm.push(job(snaps[lastIdx][kind])); // same seed as the last job: base hit
      const row = { preset: p.name, size, kind, compressedBytes: snaps[0][kind].length, initMs: snaps.map((s) => s.initMs), cold, warm };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 1));
