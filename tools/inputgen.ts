// Seeded determinism-script generator (plan 6.11 "Input script format", 12.1).
// Usage: node tools/inputgen.ts --seed 42 --bots 4 --ticks 1800 > out.json
import { encodeJoin, encodeLeave, encodePaint, encodePos, hex } from "../shared/inputs.ts";

export interface Script {
  seed: string;
  world_kind: number;
  ticks: number;
  inputs: Record<string, string[]>;
}

export interface GenOptions {
  seed: number | bigint;
  bots: number;
  ticks: number;
  worldKind?: number;
}

/** mulberry32: small integer PRNG, fully deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MATS = [0, 1, 2, 3, 4, 5, 10];
const SIZE = 512;

export function generate(opts: GenOptions): Script {
  const { bots, ticks } = opts;
  const worldKind = opts.worldKind ?? 0;
  const seed = BigInt.asUintN(64, BigInt(opts.seed));
  const rand = mulberry32(Number(seed & 0xffffffffn) ^ Number((seed >> 32n) & 0xffffffffn));
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const inputs: Record<string, string[]> = {};
  const push = (t: number, b: Uint8Array) => (inputs[String(t)] ??= []).push(hex(b));

  interface Bot { id: number; on: boolean; x: number; y: number; mat: number }
  const all: Bot[] = [];
  for (let i = 0; i < bots; i++) all.push({ id: i + 1, on: false, x: int(40, SIZE - 40), y: int(40, SIZE - 60), mat: MATS[int(0, MATS.length - 1)] });

  for (let t = 1; t <= ticks; t++) {
    for (const b of all) {
      if (!b.on) {
        // Everyone is in by tick 1 or soon after; rejoin after leaving is possible.
        if (t === 1 || rand() < 0.01) {
          b.on = true;
          push(t, encodeJoin(b.id));
        }
        continue;
      }
      if (rand() < 0.004) {
        b.on = false;
        push(t, encodeLeave(b.id));
        continue;
      }
      const ox = b.x, oy = b.y;
      b.x = Math.min(SIZE - 20, Math.max(20, b.x + int(-6, 6)));
      b.y = Math.min(SIZE - 24, Math.max(20, b.y + int(-6, 6)));
      push(t, encodePos(b.id, 100, b.x * 16, b.y * 16, int(0, 1)));
      const strokes = rand() < 0.08 ? (rand() < 0.3 ? int(2, 3) : 1) : 0;
      for (let s = 0; s < strokes; s++) {
        if (rand() < 0.4) b.mat = MATS[int(0, MATS.length - 1)];
        const x1 = Math.min(SIZE - 1, Math.max(0, ox + int(-12, 12)));
        const y1 = Math.min(SIZE - 1, Math.max(0, oy + int(-12, 12)));
        push(t, encodePaint(b.id, b.mat, ox, oy, x1, y1, int(1, 8)));
      }
    }
  }
  return { seed: seed.toString(), world_kind: worldKind, ticks, inputs };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const script = generate({
    seed: BigInt(arg("seed", "42")),
    bots: Number(arg("bots", "4")),
    ticks: Number(arg("ticks", "1800")),
    worldKind: Number(arg("world-kind", "0")),
  });
  process.stdout.write(JSON.stringify(script) + "\n");
}
