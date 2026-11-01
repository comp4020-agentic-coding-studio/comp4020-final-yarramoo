// Node-only helpers for the determinism tests.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../tools/inputgen.ts";
import type { Script } from "../../tools/inputgen.ts";
import { generateM5 } from "../../tools/inputgen-m5.ts";
import { encodeCast, encodeJoin, encodePos, encodeReady, hex } from "../../shared/inputs.ts";
import { SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { ENT_ENEMY, ENT_PICKUP, loadSim } from "../../shared/sim.ts";

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
 * F6b (D-166): a Survival room opens as a lobby; the round starts 180 ticks after the last player readies. Scripts join
 * at tick 1, send Ready at tick 2 (the countdown begins at tick 2 and the round starts at tick 182), and shift every
 * later input by LOBBY_SHIFT so the fight is the same fight as before, starting at the same offset from the round start.
 * Re-pointed expectation: what was tick T of the fight is now tick T + LOBBY_SHIFT; the hashes are compared per tick, so
 * equal hashes still mean the same fight.
 */
export const LOBBY_SHIFT = 190;
function lobbyAt(inputs: Record<string, string[]>, players: number) {
  for (let k = 1; k <= players; k++) (inputs["2"] ??= []).push(hex(encodeReady(k, 1)));
  return (t: number, b: Uint8Array) => (inputs[String(t === 1 ? 1 : t + LOBBY_SHIFT)] ??= []).push(hex(b));
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
  const at = lobbyAt(inputs, 2);
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
  const script: Script = { seed: "20261031", config: "survival", ticks: 900 + LOBBY_SHIFT, inputs } as unknown as Script;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script));
  return { script, path };
}

/**
 * F5 script: Survival tiers. Player 1 stands in an imp's open pocket (the imp fires Fire bolts at it), player 2 stands
 * 20 cells from a buried worm (the worm wakes, tunnels to it and hits it). Positions are read from the sim after init.
 */
export function tiersScript(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-survival-tiers.json");
  const sim = loadSim(readWasm(wasmPath));
  sim.init(20261031n, encodeConfig(SURVIVAL));
  const enemies = sim.entities().filter((e) => e.type === ENT_ENEMY).sort((a, b) => a.id - b.id);
  const imp = enemies.find((e) => e.sub === 1);
  const worm = enemies.find((e) => e.sub === 3);
  if (!imp || !worm) throw new Error("survival world has no imp or no worm");
  const inputs: Record<string, string[]> = {};
  const at = lobbyAt(inputs, 2);
  at(1, encodeJoin(1));
  at(1, encodeJoin(2));
  for (let t = 5; t < 600; t += 3) {
    at(t, encodePos(1, 0, imp.x + 3 * 16, imp.y + 16, 0));
    at(t, encodePos(2, 0, worm.x + 20 * 16, worm.y - 2 * 16, 0));
  }
  const script: Script = { seed: "20261031", config: "survival", ticks: 600 + LOBBY_SHIFT, inputs } as unknown as Script;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script));
  return { script, path };
}

/**
 * F6 script: the boss fight. Six players float beside the boss and cast Fire bolts and Bombs at it for 2400 ticks.
 * Positions are read from the sim after init: the boss is the enemy of kind 4. The pickups are not used: the sim gives a
 * joining player no charges, so the script also needs them; see the first Pos inputs over the supply pile below.
 */
export function bossScript(): { script: Script; path: string } {
  const path = resolve(root, "tests/determinism/.cache/script-survival-boss.json");
  const sim = loadSim(readWasm(wasmPath));
  sim.init(20261031n, encodeConfig(SURVIVAL));
  const ents = sim.entities();
  const boss = ents.find((e) => e.type === ENT_ENEMY && e.sub === 4);
  if (!boss) throw new Error("survival world has no boss");
  const inputs: Record<string, string[]> = {};
  const at = lobbyAt(inputs, 6);
  // Six players each take one supply-pile pickup (the last six: four Fire bolts, two Bombs), then stand in a ring 13-15 cells from
  // the boss's start point (inside its 14-cell closing distance, so it barely moves and the aim stays good). SCRIPTED ADVANTAGE: this fixed, perfectly aimed
  // stance (a scripted player aims at the boss's start point); a real player has to aim at a moving target. Fire bolts every 15 ticks, a Bomb when a player holds one.
  const N = 6;
  let seq = 0;
  for (let k = 0; k < N; k++) at(1, encodeJoin(k + 1));
  const loot = ents.filter((e) => e.type === ENT_PICKUP).sort((a, b) => a.id - b.id).slice(-6);
  let t0 = 3;
  loot.forEach((p, i) => {
    for (let s2 = 0; s2 < 2; s2++) at(t0 + s2 * 3, encodePos(i + 1, 0, p.x, p.y + 16, 1));
    t0 += 6;
  });
  const start = t0 + 6;
  // Stances around the boss (cells, relative to its centre, y down), so no player's bolt crosses another's box.
  const stance = [[13, 0], [-13, 0], [0, -15], [10, -10], [-10, -10], [0, -15]];
  for (let t = start; t < 2400 + start; t += 3) {
    for (let k = 0; k < N; k++) {
      const px = boss.x + stance[k][0] * 16;
      const py = boss.y - 2 * 16 + stance[k][1] * 16; // chest (5 cells up) level with the boss's centre (7 up)
      at(t, encodePos(k + 1, 0, px, py, 0));
      if ((t - start) % 15 === 0) {
        const angle = Math.round(((Math.atan2(boss.y - 7 * 16 - (py - 5 * 16), boss.x - px) / (2 * Math.PI) + 1) % 1) * 65536) & 0xffff;
        at(t, encodeCast(k + 1, k >= 4 ? 5 : 4, angle, seq++ & 0xffff));
      }
    }
  }
  const script: Script = { seed: "20261031", config: "survival", ticks: 2400 + start + LOBBY_SHIFT, inputs } as unknown as Script;
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
