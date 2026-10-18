// Cosmetic animation: pixel sprites for the figures and particles for spells (todo.md, plan 8). Everything
// here is derived from client state and the render-only entities() / events() views, and NOTHING here ever
// feeds the sim or an input (invariants 1 and 9). Floats and Math.random are fine for that reason.
import type { Rect } from "./render.ts";

export type Pose = "idle" | "walk" | "jump" | "levitate" | "cast" | "hit";

// Sprites are 7 wide and 10 tall; the 5-cell hitbox is columns 1..5 and the figure faces right (mirrored for
// left). Characters: h hair, s skin, e eye, b body, a arm, d legs, '.' nothing.
const S: Record<string, string[]> = {
  idle0: [".......", "..hhh..", "..sse..", "..sss..", ".bbbbb.", ".bbbbb.", ".bbbbb.", "..ddd..", "..d.d..", "..d.d.."],
  idle1: [".......", ".......", "..hhh..", "..sse..", ".sssbb.", ".bbbbb.", ".bbbbb.", "..ddd..", "..d.d..", "..d.d.."].map((r, i) => (i === 4 ? ".bbbbb." : r)),
  walk0: [".......", "..hhh..", "..sse..", "..sss..", ".bbbbb.", ".babbb.", ".bbbbb.", "..ddd..", "..d.d..", "..d.d.."],
  walk1: [".......", "..hhh..", "..sse..", "..sss..", ".bbbbb.", ".bbabb.", ".bbbbb.", "..ddd..", ".dd.d..", ".d..dd."],
  walk2: [".......", "..hhh..", "..sse..", "..sss..", ".bbbbb.", ".bbbab.", ".bbbbb.", "..ddd..", "..d.d..", "..d.d.."],
  walk3: [".......", "..hhh..", "..sse..", "..sss..", ".bbbbb.", ".bbabb.", ".bbbbb.", "..ddd..", "..d.dd.", ".dd..d."],
  jump: [".......", "..hhh..", "a.sse.a", ".asssa.", ".bbbbb.", ".bbbbb.", "..bbb..", "..ddd..", "..d.d..", "..d.d.."],
  levitate: [".......", "..hhh..", "..sse..", "aasssaa", ".bbbbb.", ".bbbbb.", "..bbb..", "..ddd..", "..ddd..", "...d..."],
  cast: [".......", "..hhh..", "..sse..", "..sss..", ".bbbbaa", ".bbbbaa", ".bbbbb.", "..ddd..", "..d.d..", ".dd.dd."],
  hit: [".......", "..hhh..", "..sxe..", ".asss..", "abbbb..", ".bbbbb.", "..bbbb.", "..ddd..", ".dd.dd.", ".d...d."],
};
S.idle1 = [".......", ".......", "..hhh..", "..sse..", "..sss..", ".bbbbb.", ".bbbbb.", "..ddd..", "..d.d..", "..d.d.."];

// A dropped bag (5 wide, 5 tall): t tie, p pouch, q shade. A lobbed bomb (4 x 4): k casing, f highlight.
const BAG = ["..t..", ".ppp.", "ppppp", "pqppp", ".qqq."];
const BOMB = [".kk.", "kffk", "kkkk", ".kk."];
const BAG_COL: Record<string, [number, number, number]> = { t: [0.95, 0.8, 0.35], p: [0.62, 0.42, 0.22], q: [0.4, 0.26, 0.14] };
const BOMB_COL: Record<string, [number, number, number]> = { k: [0.16, 0.16, 0.2], f: [0.6, 0.6, 0.7] };

function pushGrid(rects: Rect[], rows: string[], pal: Record<string, [number, number, number]>, x0: number, y0: number): void {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = pal[rows[y][x]];
      if (c) rects.push({ x: x0 + x, y: y0 + y, w: 1, h: 1, r: c[0], g: c[1], b: c[2] });
    }
  }
}

/** A bag resting on the cell (cx, cy): bobs by a cell now and then. `now` is ms, cosmetic only. */
export function pushBag(rects: Rect[], cx: number, cy: number, now: number): void {
  const bob = Math.sin(now / 350 + cx * 0.7) > 0.4 ? 1 : 0;
  pushGrid(rects, BAG, BAG_COL, Math.floor(cx) - 2, Math.floor(cy) - 4 - bob);
}

/** A bomb in flight: round body and a flickering fuse tip. */
export function pushBomb(rects: Rect[], x: number, y: number, now: number): void {
  const x0 = Math.round(x) - 2;
  const y0 = Math.round(y) - 2;
  pushGrid(rects, BOMB, BOMB_COL, x0, y0);
  const lit = Math.floor(now / 70) % 2;
  rects.push({ x: x0 + 2, y: y0 - 1, w: 1, h: 1, r: 1, g: lit ? 0.9 : 0.5, b: lit ? 0.4 : 0.1 });
}

const WALK = ["walk0", "walk1", "walk2", "walk3"];

const SKIN: [number, number, number] = [0.96, 0.82, 0.68];
const DARK: [number, number, number] = [0.1, 0.1, 0.14];

function colourOf(ch: string, body: [number, number, number]): [number, number, number] | null {
  switch (ch) {
    case "h": return [body[0] * 0.45, body[1] * 0.45, body[2] * 0.45];
    case "s": return SKIN;
    case "e": case "x": return DARK;
    case "b": return body;
    case "a": return [body[0] * 0.8 + 0.1, body[1] * 0.8 + 0.1, body[2] * 0.8 + 0.1];
    case "d": return [body[0] * 0.6, body[1] * 0.6, body[2] * 0.6];
    default: return null;
  }
}

/** Pick a sprite name for a pose; `t` is a free-running animation clock in "frames" (walk phase or time). */
export function spriteFor(pose: Pose, t: number): string {
  switch (pose) {
    case "walk": return WALK[Math.floor(t) & 3];
    case "idle": return Math.floor(t / 28) & 1 ? "idle1" : "idle0";
    default: return pose;
  }
}

/** Push one sprite as runs of same-coloured cells. (px, py) is the feet centre in cells. */
export function pushSprite(rects: Rect[], px: number, py: number, name: string, facingRight: boolean, body: [number, number, number]): void {
  const rows = S[name] ?? S.idle0;
  const x0 = Math.round(px) - 3;
  const y0 = Math.round(py) - 10;
  for (let y = 0; y < rows.length; y++) {
    const row = facingRight ? rows[y] : [...rows[y]].reverse().join("");
    let x = 0;
    while (x < 7) {
      const ch = row[x];
      let n = 1;
      while (x + n < 7 && row[x + n] === ch) n++;
      const c = colourOf(ch, body);
      if (c) rects.push({ x: x0 + x, y: y0 + y, w: n, h: 1, r: c[0], g: c[1], b: c[2] });
      x += n;
    }
  }
}

export interface PoseState {
  x: number;
  y: number;
  /** Measured displayed velocity, cells per 60 Hz tick. */
  vx: number;
  vy: number;
  walkPhase: number;
  airMs: number;
  castUntil: number;
  hitUntil: number;
  facingRight: boolean;
  pose: Pose;
}

export function newPoseState(x: number, y: number, facingRight: boolean): PoseState {
  return { x, y, vx: 0, vy: 0, walkPhase: 0, airMs: 0, castUntil: 0, hitUntil: 0, facingRight, pose: "idle" };
}

/**
 * Infer a pose from how a figure moved this frame plus the events that touched it. `grounded` is exact for the
 * local avatar; for others it is inferred from vertical speed. `thrusting` is the local avatar holding up in
 * the air with energy; for others a long rise stands in for it.
 */
export function updatePose(p: PoseState, x: number, y: number, dt: number, now: number, grounded: boolean | null, thrusting: boolean | null): void {
  const ticks = Math.max(dt / (1000 / 60), 0.25);
  p.vx = (x - p.x) / ticks;
  p.vy = (y - p.y) / ticks;
  p.x = x;
  p.y = y;
  const air = grounded === null ? Math.abs(p.vy) > 0.15 : !grounded;
  p.airMs = air ? p.airMs + dt : 0;
  if (Math.abs(p.vx) > 0.05) p.facingRight = p.vx > 0;
  if (!air && Math.abs(p.vx) > 0.1) p.walkPhase += Math.abs(p.vx) * ticks * 0.45;
  const lev = thrusting ?? (p.airMs > 380 && p.vy < -0.2);
  p.pose = now < p.hitUntil ? "hit" : now < p.castUntil ? "cast" : air ? (lev ? "levitate" : "jump") : Math.abs(p.vx) > 0.1 ? "walk" : "idle";
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  r: number;
  g: number;
  b: number;
  /** Downward pull, cells per ms^2 (cosmetic). */
  grav: number;
}

const MAX_PARTICLES = 600;

export class Particles {
  private list: Particle[] = [];
  private seed = 1;

  rand(): number {
    // xorshift: cosmetic only, never the sim's counter RNG
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    return ((this.seed >>> 0) % 100000) / 100000;
  }

  add(p: Omit<Particle, "age">): void {
    if (this.list.length >= MAX_PARTICLES) this.list.shift();
    this.list.push({ ...p, age: 0 });
  }

  get count(): number {
    return this.list.length;
  }

  update(dtMs: number): void {
    for (const p of this.list) {
      p.age += dtMs;
      p.vy += p.grav * dtMs;
      p.x += p.vx * dtMs;
      p.y += p.vy * dtMs;
    }
    this.list = this.list.filter((p) => p.age < p.life);
  }

  toRects(out: Rect[]): void {
    for (const p of this.list) {
      const k = 1 - p.age / p.life;
      out.push({ x: Math.round(p.x - p.size / 2), y: Math.round(p.y - p.size / 2), w: p.size, h: p.size, r: p.r, g: p.g, b: p.b, a: Math.min(1, k * 1.4) });
    }
  }

  /** A ring of sparks (impact burst) at a cell. */
  burst(x: number, y: number, c: [number, number, number], n = 14, speed = 0.05): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rand() * 0.5;
      const s = speed * (0.5 + this.rand());
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 260 + this.rand() * 180, size: this.rand() < 0.3 ? 2 : 1, r: c[0], g: c[1], b: c[2], grav: 0.00008 });
    }
    this.add({ x, y, vx: 0, vy: 0, life: 90, size: 5, r: 1, g: 1, b: 1, grav: 0 });
  }

  /** The cone flash of Blast: sparks flung along the aim angle (radians), fanned 45 degrees either side. */
  cone(x: number, y: number, angle: number, c: [number, number, number]): void {
    for (let i = 0; i < 46; i++) {
      const a = angle + (this.rand() - 0.5) * (Math.PI / 2);
      const s = 0.05 + this.rand() * 0.11;
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 150 + this.rand() * 130, size: this.rand() < 0.25 ? 2 : 1, r: c[0], g: c[1], b: c[2], grav: 0 });
    }
  }

  /** A small flash where a bolt leaves the caster. */
  flash(x: number, y: number, angle: number, c: [number, number, number]): void {
    this.add({ x: x + Math.cos(angle) * 3, y: y + Math.sin(angle) * 3, vx: 0, vy: 0, life: 80, size: 3, r: 1, g: 1, b: 1, grav: 0 });
    for (let i = 0; i < 6; i++) {
      const a = angle + (this.rand() - 0.5) * 0.9;
      const s = 0.04 + this.rand() * 0.05;
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 160, size: 1, r: c[0], g: c[1], b: c[2], grav: 0 });
    }
  }

  /** Streaks trailing behind a knocked-back figure; (dx, dy) is the direction it is flying. */
  streak(x: number, y: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < 9; i++) {
      const back = i * 1.3;
      this.add({ x: x - (dx / len) * back, y: y - (dy / len) * back + (this.rand() - 0.5) * 3, vx: -(dx / len) * 0.01, vy: -(dy / len) * 0.01, life: 200 + i * 20, size: i < 3 ? 2 : 1, r: 1, g: 1, b: 1, grav: 0 });
    }
  }

  /** One-cell trail puff behind a bolt. */
  trail(x: number, y: number, c: [number, number, number]): void {
    this.add({ x: x + (this.rand() - 0.5), y: y + (this.rand() - 0.5), vx: 0, vy: 0, life: 220, size: 1, r: c[0] * 0.9, g: c[1] * 0.9, b: c[2] * 0.9, grav: 0 });
  }

  /** Fiery trail puff behind a Fire bolt: orange to yellow, rising a little. */
  fireTrail(x: number, y: number): void {
    const hot = this.rand();
    this.add({ x: x + (this.rand() - 0.5), y: y + (this.rand() - 0.5), vx: 0, vy: -0.004, life: 260, size: 1, r: 1, g: 0.35 + hot * 0.5, b: 0.05 + hot * 0.1, grav: 0 });
  }

  /** Embers thrown up where a Fire bolt lands. */
  embers(x: number, y: number): void {
    for (let i = 0; i < 18; i++) {
      const a = -Math.PI / 2 + (this.rand() - 0.5) * 2.4;
      const s = 0.02 + this.rand() * 0.05;
      const hot = this.rand();
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 350 + this.rand() * 350, size: this.rand() < 0.25 ? 2 : 1, r: 1, g: 0.3 + hot * 0.55, b: 0.05, grav: 0.00005 });
    }
    this.add({ x, y, vx: 0, vy: 0, life: 90, size: 4, r: 1, g: 0.85, b: 0.5, grav: 0 });
  }

  /** A spark off a bomb's fuse (sparse). */
  fuseSpark(x: number, y: number): void {
    if (this.rand() < 0.5) this.add({ x, y, vx: (this.rand() - 0.5) * 0.03, vy: -0.01 - this.rand() * 0.02, life: 160, size: 1, r: 1, g: 0.85, b: 0.3, grav: 0.00004 });
  }

  /**
   * An explosion of the given radius in cells: a flash, an expanding ring and debris. Scaled so a bomb (18) is big and
   * gunpowder (4) small; the particle count is capped by radius and by the shared pool limit.
   */
  explosion(x: number, y: number, radius: number): void {
    const big = Math.min(1, radius / 18);
    this.add({ x, y, vx: 0, vy: 0, life: 110, size: Math.max(4, Math.round(radius * 0.9)), r: 1, g: 0.95, b: 0.75, grav: 0 });
    const ring = 10 + Math.round(26 * big);
    const speed = (radius / 260) * 1.0; // the ring reaches about `radius` cells in 260 ms
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      this.add({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 260, size: 1, r: 1, g: 0.75, b: 0.25, grav: 0 });
    }
    const debris = 8 + Math.round(30 * big);
    for (let i = 0; i < debris; i++) {
      const a = this.rand() * Math.PI * 2;
      const s = speed * (0.3 + this.rand() * 0.9);
      const dark = this.rand() < 0.5;
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.01, life: 400 + this.rand() * 500, size: this.rand() < 0.3 ? 2 : 1, r: dark ? 0.25 : 1, g: dark ? 0.2 : 0.5, b: dark ? 0.2 : 0.1, grav: 0.00006 });
    }
  }

  /** A short bright flash and a few motes rising where a player comes back. */
  respawn(x: number, y: number): void {
    this.add({ x, y, vx: 0, vy: 0, life: 160, size: 7, r: 0.8, g: 1, b: 0.9, grav: 0 });
    for (let i = 0; i < 10; i++) this.add({ x: x + (this.rand() - 0.5) * 6, y: y + 4, vx: 0, vy: -0.02 - this.rand() * 0.03, life: 300, size: 1, r: 0.7, g: 1, b: 0.85, grav: 0 });
  }

  /** A pickup flash where a bag was taken. */
  pickup(x: number, y: number): void {
    this.add({ x, y, vx: 0, vy: 0, life: 120, size: 6, r: 1, g: 0.95, b: 0.6, grav: 0 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this.add({ x, y, vx: Math.cos(a) * 0.03, vy: Math.sin(a) * 0.03 - 0.02, life: 300, size: 1, r: 1, g: 0.85, b: 0.3, grav: 0 });
    }
  }
}
