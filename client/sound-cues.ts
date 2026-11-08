// Pure sound-cue helpers (display only; invariants 1 and 9: they read outputs and produce sound names, never inputs).
import { CAUSE_ACID, CAUSE_FIRE, CAUSE_GUNPOWDER, CAUSE_LAVA, ENT_ENEMY, EV_EXPLODE, EV_IMPACT, EV_KNOCK } from "../shared/sim.ts";
import { HITBOX_H, HITBOX_W, SIZZLE_GAP_MS, hitboxMaterials } from "./hazard.ts";
import type { SfxName } from "./sfx.ts";

/** One cast sound per spell id 0..14. */
export const SPELL_SFX: SfxName[] = [
  "push", "blast", "water", "rose", "fire", "bomb", "dig", "acidflask", "flask", "wall", "lavaflask", "hole", "freeze", "quake", "mudslide",
];
// Spell ids: 7 acid flask, 8 oil flask, 10 lava flask, 12 freeze, 13 quake, 14 mud slide.

export interface CueEvent { kind: number; player: number; a: number; b: number; c: number }
export interface CueEnt { type: number; id: number; active: boolean; sub: number; x: number; y: number }
export interface HurtInput {
  events: readonly CueEvent[];
  ents: readonly CueEnt[];
  myId: number;
  /** My feet centre, 1/16 cell. */
  x: number;
  y: number;
  mat: Uint8Array;
  w: number;
  h: number;
}

const enemyKind = (owner: number) => 40 + ((owner >>> 16) & 0xff);

/** Infer the cause of a non-lethal hurt from this frame's outputs; null if nothing explains it. Peeks, never consumes. */
export function hurtCause(i: HurtInput): number | null {
  const mx = i.x / 16;
  const my = i.y / 16;
  const chestY = my - 5;
  for (const e of i.events) {
    if (e.kind !== EV_EXPLODE) continue;
    if (Math.hypot(e.a - mx, e.b - chestY) <= e.c + 2) return e.player >= 0x80000000 ? enemyKind(e.player) : e.player === 0 ? CAUSE_GUNPOWDER : 5;
  }
  for (const e of i.events) {
    if (e.kind !== EV_IMPACT || e.c !== 4) continue;
    const dx = Math.max(0, Math.abs(e.a - mx) - HITBOX_W / 2);
    const dy = Math.max(0, my - HITBOX_H - e.b, e.b - my);
    if (Math.hypot(dx, dy) <= 4) return e.player >= 0x80000000 ? enemyKind(e.player) : 4;
  }
  for (const e of i.events) {
    if (e.kind === EV_KNOCK && e.player === i.myId && e.c === 0 && Math.abs(e.a) === 40 && e.b === -24) {
      let best = -1, bd = Infinity;
      for (const q of i.ents) {
        if (q.type !== ENT_ENEMY || !q.active) continue;
        const d = Math.hypot(q.x - i.x, q.y - i.y);
        if (d < bd) { bd = d; best = q.sub; }
      }
      if (best >= 0) return 40 + best;
    }
  }
  const m = hitboxMaterials(i.mat, i.w, i.h, i.x, i.y);
  if (m.lava) return CAUSE_LAVA;
  if (m.fire) return CAUSE_FIRE;
  if (m.acid) return CAUSE_ACID;
  return null;
}

const ENEMY_HIT: SfxName[] = ["slimehit", "imphit", "acidhit", "wormbite", "magehit", "wisphit", "frosthit", "colossushit"];

export function damageSound(cause: number | null): SfxName {
  if (cause === null) return "hurt";
  if (cause === CAUSE_LAVA) return "sizzle";
  if (cause === CAUSE_FIRE) return "burn";
  if (cause === CAUSE_ACID) return "corrode";
  if (cause === CAUSE_GUNPOWDER) return "powderhit";
  if (cause === 5) return "blasthit";
  if (cause === 4) return "bolthit";
  if (cause >= 40 && cause < 40 + ENEMY_HIT.length) return ENEMY_HIT[cause - 40];
  return "hurt";
}

export type HurtClass = "hazard" | "hit";
export const HIT_GAP_MS = 120;
export const hurtClass = (cause: number | null): HurtClass => (cause === CAUSE_LAVA || cause === CAUSE_FIRE || cause === CAUSE_ACID ? "hazard" : "hit");

/** Hazards share one SIZZLE_GAP_MS gap, discrete hits HIT_GAP_MS. `last` holds the last play time per class. */
export const shouldPlayHurt = (cls: HurtClass, now: number, last: Record<HurtClass, number>): boolean =>
  now - last[cls] >= (cls === "hazard" ? SIZZLE_GAP_MS : HIT_GAP_MS);

// ---- Ambient water ----------------------------------------------------------------------------------------------

/** Water samples on a world-aligned grid: sample (i, j) is world cell (i * stride, j * stride); i from i0, j from j0. */
export interface WaterSamples { stride: number; i0: number; j0: number; ni: number; nj: number; bits: Uint8Array }
export interface Win { x: number; y: number; w: number; h: number }
const WATER_CELL = 5;
/** Weighted changed samples below this read as silence (a drip), then the rest scales to 0..1 over WATER_SCALE. */
export const WATER_FLOOR = 8;
export const WATER_SCALE = 80;

export function waterMotion(
  mat: Uint8Array, w: number, h: number, win: Win, stride: number, prev: WaterSamples | null, cx: number, cy: number,
): { level: number; pan: number; next: WaterSamples } {
  const x0 = Math.max(0, Math.floor(win.x)), y0 = Math.max(0, Math.floor(win.y));
  const x1 = Math.min(w, Math.ceil(win.x + win.w)), y1 = Math.min(h, Math.ceil(win.y + win.h));
  const i0 = Math.ceil(x0 / stride), j0 = Math.ceil(y0 / stride);
  const ni = Math.max(0, Math.ceil(x1 / stride) - i0), nj = Math.max(0, Math.ceil(y1 / stride) - j0);
  const bits = new Uint8Array(ni * nj);
  const next: WaterSamples = { stride, i0, j0, ni, nj, bits };
  const R = Math.max(1, win.w / 2);
  let sum = 0, panSum = 0;
  for (let j = 0; j < nj; j++) {
    const y = (j0 + j) * stride;
    if (y >= h) break;
    for (let i = 0; i < ni; i++) {
      const x = (i0 + i) * stride;
      if (x >= w) break;
      const wet = mat[y * w + x] === WATER_CELL ? 1 : 0;
      bits[j * ni + i] = wet;
      if (!prev || prev.stride !== stride) continue;
      const pi = i0 + i - prev.i0, pj = j0 + j - prev.j0;
      if (pi < 0 || pj < 0 || pi >= prev.ni || pj >= prev.nj) continue; // outside the overlap
      if (prev.bits[pj * prev.ni + pi] === wet) continue;
      const wt = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / R);
      sum += wt;
      panSum += wt * ((x - cx) / R);
    }
  }
  const level = Math.max(0, Math.min(1, (sum - WATER_FLOOR) / WATER_SCALE));
  const pan = sum > 0 ? Math.max(-1, Math.min(1, panSum / sum)) : 0;
  return { level, pan: level > 0 ? pan : 0, next };
}
