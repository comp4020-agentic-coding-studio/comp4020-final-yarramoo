// Node-only helpers for the determinism tests.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../tools/inputgen.ts";
import type { Script } from "../../tools/inputgen.ts";
import { generateM5 } from "../../tools/inputgen-m5.ts";
import { encodeCast, encodeJoin, encodePos, hex } from "../../shared/inputs.ts";
import { SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { ENT_ENEMY, loadSim } from "../../shared/sim.ts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const wasmPath = resolve(root, "sim/target/wasm32-unknown-unknown/release/sim.wasm");
export const canaryPath = resolve(root, "sim/target-canary/wasm32-unknown-unknown/release/sim.wasm");
export const cargoEnv = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

export const readWasm = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

/** The shared 4 bots x 1800 ticks script, cached on disk. */
export function sharedScript(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-4x1800.json");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(generate({ seed: 42, bots: 4, ticks: 1800, worldKind: 0 })));
  }
  return { script: JSON.parse(readFileSync(path, "utf8")) as Script, path };
}

export function sh(cmd: string, args: string[], cwd = root): string {
  return execFileSync(cmd, args, { cwd, env: cargoEnv, encoding: "utf8", maxBuffer: 1 << 28 });
}

/** D8 script: a game world (world_kind 1), no inputs, 300 ticks. Cached on disk for the browser runner. */
export function gameScript(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-game.json");
  const script: Script = { seed: "20261014", world_kind: 1, ticks: 300, inputs: {} };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script));
  return { script, path };
}

/** M4b script: three bots in the game world, Joining, moving and casting (Push, Blast, refused spells) for 900 ticks. */
export function castScript(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-game-cast.json");
  const script = generate({ seed: 7, bots: 3, ticks: 900, worldKind: 1 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script));
  return { script, path };
}

/**
 * F4 script: a Survival-config world (enemies on). Two players join at the surface, then walk next to real slimes
 * (positions read from the sim after init, a pure function of the seed) and Push/Blast them, so slime hops,
 * contact damage, enemy damage, kills and the one-life rules all run. Plain input list, like the M5 script.
 */
export function survivalScript(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-survival.json");
  const sim = loadSim(readWasm(wasmPath));
  sim.init(20261031n, encodeConfig(SURVIVAL));
  const slimes = sim.entities().filter((e) => e.type === ENT_ENEMY).sort((a, b) => a.id - b.id);
  if (slimes.length < 3) throw new Error(`survival world has ${slimes.length} slimes`);
  const inputs: Record<string, string[]> = {};
  const at = (t: number, b: Uint8Array) => (inputs[String(t)] ??= []).push(hex(b));
  at(1, encodeJoin(1));
  at(1, encodeJoin(2));
  let seq = 0;
  for (let k = 0; k < 3; k++) {
    const e = slimes[k];
    const t0 = 5 + k * 280;
    for (let t = t0; t < t0 + 270; t += 3) {
      // player 1 stands 12 cells left of the slime and keeps casting right; player 2 stands on it and takes hits
      // one cell lower than the slime's feet so the chest-height bolt crosses its top row
      at(t, encodePos(1, 0, e.x - 12 * 16, e.y + 16, 1));
      at(t, encodePos(2, 0, e.x + 16 * (k + 1), e.y, 0));
      // Push every 24 ticks (its cooldown is 20); every fifth cast is a Blast (cooldown 90), 120 ticks after the last one
      if ((t - t0) % 24 === 0) at(t, encodeCast(1, ((t - t0) / 24) % 5 === 4 ? 1 : 0, 0, seq++ & 0xffff));
    }
  }
  const script: Script = { seed: "20261031", config: "survival", ticks: 900, inputs } as unknown as Script;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script));
  return { script, path };
}

/** M5 script: three bots collect Bomb and Fire bolt pickups, hit and kill each other, respawn and take a bag. Needs the built wasm. */
export function m5Script(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-game-m5.json");
  const script = generateM5(readWasm(wasmPath));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script));
  return { script, path };
}
