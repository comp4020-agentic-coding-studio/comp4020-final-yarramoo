// The M5 determinism scenario (game world): pickups, bombs, Fire bolts, damage, deaths, bags, respawn.
// The old `generateGame` bots never leave the surface and never collect a pickup, so every Fire bolt and Bomb
// they cast is refused and nobody ever takes damage. This generator needs real pickup positions, so it loads
// the real sim.wasm once while generating (option (a) in the slice brief): pickups are a pure function of the
// seed (D-052/D-062) and the sim is read, never written, except through the same inputs the script records.
// The output is still a plain input list, so determinism of the run itself is unaffected, and the same seed and
// sim build give the same file. Closed loop in one place only: after a death the bot returns to its bag, so the
// generator watches EV_RESPAWN and the bag list. Positions and angles are integers before they become inputs
// (invariant 2).
import { encodeCast, encodeJoin, encodePos, hex } from "../shared/inputs.ts";
import { ENT_BAG, ENT_PICKUP, ENT_PROJECTILE, EV_DEATH, EV_RESPAWN, loadSim } from "../shared/sim.ts";
import type { Script } from "./inputgen.ts";

const SPELL_FIRE = 4;
const SPELL_BOMB = 5;
const UP = 49152;
const DOWN = 16384;

/** Angle from (ax, ay) to (bx, by) as a u16 turn, y down (0 = right, 16384 = down, 49152 = up). */
function angleTo(ax: number, ay: number, bx: number, by: number): number {
  const turn = Math.atan2(by - ay, bx - ax) / (2 * Math.PI);
  return Math.round(((turn % 1) + 1) % 1 * 65536) & 0xffff;
}

export const M5_SEED = 20261014n;
export const M5_TICKS = 900;

export function generateM5(wasm: Uint8Array, seed: bigint = M5_SEED, ticks: number = M5_TICKS): Script {
  const sim = loadSim(wasm);
  sim.init(seed, 1);
  const inputs: Record<string, string[]> = {};
  let t = 0;
  const pending: Uint8Array[] = [];
  const queue = (b: Uint8Array) => pending.push(b);
  const lives: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  const dead = new Set<number>();
  const respawnedAt: Record<number, number> = {};
  const seq: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  const cast = (id: number, spell: number, angle: number) => queue(encodeCast(id, spell, angle, seq[id]++ & 0xffff));
  const goto = (id: number, x: number, y: number) => queue(encodePos(id, lives[id], x, y, id & 1));

  // First joined step: read the pickup list (deep ones only, sorted by id for a stable choice).
  queue(encodeJoin(1));
  queue(encodeJoin(2));
  queue(encodeJoin(3));
  const pickups = (spell: number) => {
    const list = sim.entities().filter((e) => e.type === ENT_PICKUP && e.sub === spell).sort((a, b) => a.id - b.id);
    if (list.length < 3) throw new Error(`need 3 pickups of spell ${spell}, world has ${list.length}`);
    return list;
  };
  let bomb: ReturnType<typeof pickups> = [];
  let fire: ReturnType<typeof pickups> = [];
  // The bots meet at the first Fire pickup's cell (set at tick 1).
  let px = 0;
  let py = 0;

  const scheduled = (): void => {
    switch (t) {
      case 2: for (let i = 0; i < 3; i++) goto(i + 1, bomb[i].x, bomb[i].y); break;
      case 3: for (let i = 0; i < 3; i++) goto(i + 1, fire[i].x, fire[i].y); break;
      case 5:
        goto(1, px, py);
        goto(2, px + 3 * 16, py);
        goto(3, px - 3 * 16, py);
        break;
      // Direct hits and knockback: 1 and 3 fire bolts at 2, then 2 at 1.
      case 8: cast(1, SPELL_FIRE, angleTo(px, py, px + 3 * 16, py)); break;
      case 14: cast(3, SPELL_FIRE, angleTo(px - 3 * 16, py, px + 3 * 16, py)); break;
      case 20: cast(2, SPELL_FIRE, angleTo(px + 3 * 16, py, px, py)); break;
      case 26: cast(1, SPELL_FIRE, UP); break;
      // A bomb straight up from a deep cave: explodes, carves, primes gunpowder.
      case 40: cast(3, SPELL_BOMB, UP); break;
      // Bombs at their own feet and at each other: self-damage, explosion damage with credit, then deaths.
      case 70: cast(1, SPELL_BOMB, DOWN); cast(2, SPELL_BOMB, angleTo(px + 3 * 16, py, px, py)); break;
      case 135: cast(1, SPELL_BOMB, DOWN); cast(2, SPELL_BOMB, DOWN); break;
      case 200: cast(1, SPELL_BOMB, DOWN); cast(2, SPELL_BOMB, DOWN); break;
      case 265: cast(1, SPELL_BOMB, DOWN); cast(2, SPELL_BOMB, DOWN); break;
      case 330: cast(1, SPELL_BOMB, DOWN); cast(2, SPELL_BOMB, DOWN); break;
      // Bot 3 stays up and keeps throwing fire bolts, so a casting survivor goes on while the others are dead.
      case 100: case 160: case 220: case 280: cast(3, SPELL_FIRE, angleTo(px - 3 * 16, py, px, py)); break;
      // Bot 2, respawned and empty-handed, takes a fresh Bomb pickup and bombs its own feet until it dies:
      // a self-kill with no other player's credit.
      case 300: goto(2, bomb[3].x, bomb[3].y); break;
      case 305: case 370: case 435: case 500: case 565: goto(2, bomb[3].x, bomb[3].y); cast(2, SPELL_BOMB, UP); break;
      default:
    }
  };

  for (t = 1; t <= ticks; t++) {
    if (t === 1) {
      // Pickup positions are readable only after init; init has already run.
      bomb = pickups(SPELL_BOMB);
      fire = pickups(SPELL_FIRE);
      px = fire[0].x;
      py = fire[0].y;
    }
    scheduled();
    // Reactive: a respawned bot walks back to the nearest bag one tick later.
    for (const id of [1, 2, 3]) {
      if (respawnedAt[id] === t - 1 && sim.entities().some((e) => e.type === ENT_BAG && e.active)) {
        const me = sim.entities().find((e) => e.type === 1 && e.id === id)!;
        const bags = sim.entities().filter((e) => e.type === ENT_BAG && e.active);
        bags.sort((a, b) => Math.abs(a.x - me.x) + Math.abs(a.y - me.y) - (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)) || a.id - b.id);
        goto(id, bags[0].x, bags[0].y);
      }
    }
    // Bot 2 chases its own bombs: while one of its bombs flies it stands on it, so the blast hits its owner.
    if (t > 305 && !dead.has(2) && lives[2] >= 1) {
      const mine = sim.entities().find((e) => e.type === ENT_PROJECTILE && e.id === 2 && e.sub === SPELL_BOMB);
      if (mine) goto(2, mine.x, mine.y);
    }
    for (const b of pending) (inputs[String(t)] ??= []).push(hex(b));
    for (const b of pending) sim.pushInput(b);
    pending.length = 0;
    sim.step();
    for (const e of sim.events()) {
      if (e.kind === EV_DEATH) dead.add(e.player);
      if (e.kind === EV_RESPAWN) {
        dead.delete(e.player);
        lives[e.player] = e.c;
        respawnedAt[e.player] = t;
      }
    }
  }
  return { seed: seed.toString(), world_kind: 1, ticks, inputs };
}
