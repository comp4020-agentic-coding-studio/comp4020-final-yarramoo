// Ambient life (cosmetic only): leaves, butterflies, fireflies and cave drips drawn into the rects list.
// It owns its own small pool so spells never lose particles to it, reads only the material view and the
// camera rectangle, and writes nothing but rects (invariants 1 and 9: nothing here feeds the sim).
import type { Rect } from "./render.ts";

export const AMBIENT_CAP = 120;
const MAX_SPAWN = 3;
const MAX_SAMPLES = 40;
const CAP_BUTTERFLY = 6;
const CAP_FIREFLY = 25;
const DIRT = 3, WATER = 5, STEM = 8, FLOWER = 9, MOSS = 23, MUSHROOM = 24, ROCK = 2;

type Kind = "leaf" | "butterfly" | "firefly" | "drip";
interface P { kind: Kind; x: number; y: number; ox: number; vx: number; vy: number; age: number; life: number; ph: number; r: number; g: number; b: number }
export interface View { x: number; y: number; w: number; h: number }

export class Ambient {
  private list: P[] = [];
  private sky = 1;
  private reduced = false;
  private rand: () => number;
  constructor(rand: () => number = Math.random) { this.rand = rand; }

  setSky(kind: number): void { this.sky = kind; }
  setReduced(r: boolean): void { this.reduced = r; if (r) this.list.length = 0; }
  clear(): void { this.list.length = 0; }
  get count(): number { return this.list.length; }
  /** Read-only view of live particles (tests). */
  get particles(): readonly P[] { return this.list; }

  private count_(k: Kind): number { let n = 0; for (const p of this.list) if (p.kind === k) n++; return n; }

  private add(p: P): void { if (this.list.length < AMBIENT_CAP) this.list.push(p); }

  /** `surf`: generated ground line per column (null: no game terrain, nothing spawns). */
  update(dt: number, view: View, mat: Uint8Array, w: number, h: number, surf: ArrayLike<number> | null): void {
    if (this.reduced) return;
    const s = Math.min(dt, 100) / 1000;
    const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 1 : mat[y * w + x]);
    // Move and retire.
    let j = 0;
    for (const p of this.list) {
      p.age += s;
      if (p.age >= p.life) continue;
      if (p.kind === "leaf") { p.y += p.vy * s; p.x = p.ox + Math.sin(p.age * 2 + p.ph) * 1.5; }
      else if (p.kind === "drip") {
        p.vy += 40 * s; p.y += p.vy * s;
        if (at(Math.floor(p.x), Math.floor(p.y)) !== 0) continue;
      } else {
        p.x += (Math.sin(p.age * 1.3 + p.ph) * (p.kind === "butterfly" ? 6 : 1.5)) * s;
        p.y += (Math.cos(p.age * 1.7 + p.ph * 2) * (p.kind === "butterfly" ? 4 : 1.5)) * s;
      }
      this.list[j++] = p;
    }
    this.list.length = j;
    if (!surf) return;

    const x0 = Math.max(0, Math.floor(view.x)), y0 = Math.max(0, Math.floor(view.y));
    const x1 = Math.min(w, Math.ceil(view.x + view.w)), y1 = Math.min(h, Math.ceil(view.y + view.h));
    if (x1 <= x0 || y1 <= y0) return;
    const night = this.sky === 0 || this.sky === 4;
    const day = this.sky === 1 || this.sky === 2;
    let spawned = 0;
    for (let i = 0; i < MAX_SAMPLES && spawned < MAX_SPAWN && this.list.length < AMBIENT_CAP; i++) {
      const x = x0 + Math.floor(this.rand() * (x1 - x0));
      const y = y0 + Math.floor(this.rand() * (y1 - y0));
      const m = mat[y * w + x];
      const ground = surf[x];
      const above = y < ground;
      const r = this.rand();
      if (m === STEM && above && at(x, y + 1) === 0 && r < 0.3) {
        const g = this.rand();
        this.add({ kind: "leaf", x: x + 0.5, y: y + 1, ox: x + 0.5, vx: 0, vy: 2 + this.rand() * 2, age: 0, life: 3 + this.rand() * 2, ph: this.rand() * 6.28, r: 0.3 + 0.3 * g, g: 0.6 + 0.15 * g, b: 0.15 });
        spawned++;
      } else if (m === FLOWER && above && day && r < 0.05 && this.count_("butterfly") < CAP_BUTTERFLY) {
        const c = this.rand() < 0.5 ? [1, 0.7, 0.2] : [0.9, 0.5, 0.9];
        this.add({ kind: "butterfly", x: x + 0.5, y: y - 2, ox: x, vx: 0, vy: 0, age: 0, life: 6 + this.rand() * 4, ph: this.rand() * 6.28, r: c[0], g: c[1], b: c[2] });
        spawned++;
      } else if (((above && night && (m === STEM || m === FLOWER)) || m === MOSS || m === MUSHROOM) && this.rand() < 0.15 && this.count_("firefly") < CAP_FIREFLY) {
        const fy = y + Math.floor(this.rand() * 7) - 3;
        if (fy >= y0 && fy < y1 && at(x, fy) === 0) {
          this.add({ kind: "firefly", x: x + 0.5, y: fy + 0.5, ox: x, vx: 0, vy: 0, age: 0, life: 5 + this.rand() * 5, ph: this.rand() * 6.28, r: 0.85, g: 1, b: 0.3 });
          spawned++;
        }
      } else if (!above && (m === ROCK || m === DIRT) && y > ground && at(x, y + 1) === 0 && r < 0.1) {
        let wet = false;
        for (let dy = -3; dy <= 3 && !wet; dy++) for (let dx = -3; dx <= 3; dx++) if (at(x + dx, y + dy) === WATER) { wet = true; break; }
        if (wet || this.rand() < 0.25) {
          this.add({ kind: "drip", x: x + 0.5, y: y + 1.2, ox: x, vx: 0, vy: 0, age: 0, life: 1.5, ph: 0, r: 0.6, g: 0.8, b: 1 });
          spawned++;
        }
      }
    }
  }

  toRects(out: Rect[]): void {
    for (const p of this.list) {
      const k = 1 - p.age / p.life;
      const x = Math.round(p.x), y = Math.round(p.y);
      if (p.kind === "butterfly") {
        const wide = Math.floor(p.age * 8) % 2 === 0 ? 2 : 1;
        out.push({ x: x - 1, y, w: wide, h: 1, r: p.r, g: p.g, b: p.b, a: Math.min(1, k * 3) });
        out.push({ x, y: y + 1, w: 1, h: 1, r: 0.2, g: 0.15, b: 0.1, a: Math.min(1, k * 3) });
      } else if (p.kind === "firefly") {
        const pulse = 0.5 + 0.5 * Math.sin(p.age * 4 + p.ph);
        out.push({ x, y, w: 1, h: 1, r: p.r, g: p.g, b: p.b, a: pulse * Math.min(1, k * 3) });
      } else {
        out.push({ x, y, w: 1, h: 1, r: p.r, g: p.g, b: p.b, a: Math.min(1, k * 1.5) });
      }
    }
  }
}
