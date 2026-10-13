import type { RunResult } from "./run.ts";

export interface Divergence {
  tick: number | null; // first diverging hash-log tick, null if only chunks differ
  a?: string;
  b?: string;
  chunks: number[];
  message: string;
}

/** Returns null when equal; otherwise the first diverging tick and the diverging chunk indices. */
export function compare(a: RunResult, b: RunResult, labels: [string, string] = ["a", "b"]): Divergence | null {
  let tick: number | null = null;
  let ha: string | undefined;
  let hb: string | undefined;
  const n = Math.max(a.hashes.length, b.hashes.length);
  for (let i = 0; i < n; i++) {
    const x = a.hashes[i];
    const y = b.hashes[i];
    if (!x || !y || x[0] !== y[0] || x[1] !== y[1]) {
      tick = (x ?? y)![0];
      ha = x?.[1];
      hb = y?.[1];
      break;
    }
  }
  const chunks: number[] = [];
  const m = Math.max(a.finalChunkHashes.length, b.finalChunkHashes.length);
  for (let i = 0; i < m; i++) if (a.finalChunkHashes[i] !== b.finalChunkHashes[i]) chunks.push(i);
  if (tick === null && chunks.length === 0) return null;
  const message =
    `${labels[0]} vs ${labels[1]}: first diverging tick ${tick ?? "none in hash log"}` +
    (tick !== null ? ` (${ha} != ${hb})` : "") +
    `; diverging chunks at end: [${chunks.join(", ")}]`;
  return { tick, a: ha, b: hb, chunks, message };
}
