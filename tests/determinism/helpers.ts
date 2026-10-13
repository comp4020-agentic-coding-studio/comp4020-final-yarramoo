// Node-only helpers for the determinism tests.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../tools/inputgen.ts";
import type { Script } from "../../tools/inputgen.ts";

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
