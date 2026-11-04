// What is under the mouse: a pure lookup, enemy over player over pickup/bag/heal over material. Display only (invariant 9):
// nothing here becomes an input, and nothing is sent to the server.
import { MATERIAL_NAMES, SPELL_NAMES } from "../shared/names.ts";
import { ENT_BAG, ENT_ENEMY, ENT_HEAL, ENT_PICKUP, ENT_PLAYER, type EntityView } from "../shared/sim.ts";
import { ENEMY_NAMES } from "./toasts.ts";

const ENEMY_MAX_HP = [20, 30, 60, 90, 800, 600];
/** Half-width and height (cells) of an enemy's hit box above its feet line, by kind. The Deep Mage is big. */
const ENEMY_BOX: [number, number][] = [[4, 6], [4, 9], [5, 7], [5, 5], [12, 24], [6, 13]];
const SLACK = 1.5;

/** The label for the world point (x, y in cells), or null for nothing worth naming. */
export function lookupHover(
  x: number,
  y: number,
  ents: readonly EntityView[],
  mat: Uint8Array,
  w: number,
  h: number,
  nameOf: (id: number) => string | undefined,
): string | null {
  // 1. Enemies (feet at e.x/16, e.y/16; the box rises from there).
  for (const e of ents) {
    if (e.type !== ENT_ENEMY) continue;
    const ex = e.x / 16;
    const ey = e.y / 16;
    const [hw, hh] = ENEMY_BOX[e.sub] ?? [4, 6];
    if (Math.abs(x - ex) <= hw + SLACK && y >= ey - hh - SLACK && y <= ey + SLACK) {
      const max = ENEMY_MAX_HP[e.sub] ?? 20;
      return `${ENEMY_NAMES[e.sub] ?? "Monster"} ${e.a}/${max}`;
    }
  }
  // 2. Players (alive only; feet at e.y/16, a 5 x 10 box).
  for (const e of ents) {
    if (e.type !== ENT_PLAYER || !e.active || e.health === 0) continue;
    const px = e.x / 16;
    const py = e.y / 16;
    if (Math.abs(x - px) <= 2.5 + SLACK && y >= py - 10 - SLACK && y <= py + SLACK) return nameOf(e.id) ?? "Player";
  }
  // 3. Pickups, bags and heals.
  for (const e of ents) {
    if (e.type === ENT_PICKUP && e.active) {
      if (Math.abs(x - e.x / 16) <= 3 + SLACK && Math.abs(y - (e.y / 16 - 1)) <= 3 + SLACK) return `${SPELL_NAMES[e.sub] ?? "Spell"} x${e.a}`;
    } else if (e.type === ENT_BAG) {
      if (Math.abs(x - e.x / 16) <= 3 + SLACK && Math.abs(y - e.y / 16) <= 3 + SLACK) return `Bag, ${e.a} charges`;
    } else if (e.type === ENT_HEAL) {
      if (Math.abs(x - e.x / 16) <= 3 + SLACK && Math.abs(y - e.y / 16) <= 3 + SLACK) return `Heal +${e.a}`;
    }
  }
  // 4. The material of the cell (nothing for Empty).
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
  const m = mat[cy * w + cx];
  return m === 0 ? null : (MATERIAL_NAMES[m] ?? null);
}
