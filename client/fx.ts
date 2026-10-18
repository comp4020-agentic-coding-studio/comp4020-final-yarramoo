// Cosmetic animation: pixel sprites for the figures and particles for spells (todo.md, plan 8). Everything
// here is derived from client state and the render-only entities() / events() views, and NOTHING here ever
// feeds the sim or an input (invariants 1 and 9). Floats and Math.random are fine for that reason.
import type { Rect } from "./render.ts";

export type Pose = "idle" | "walk" | "jump" | "levitate" | "cast" | "hit";

// Sprites are 7 wide and 10 tall; the 5-cell hitbox is columns 1..5 and the figure faces right (mirrored for
// left). Characters: h hood, H hood highlight, s skin, e eye, x hurt eye, b robe, B robe shade, l robe highlight,
// t belt, a sleeve, g hand glow (the spell colour), d feet, '.' nothing. Hand-reduced from docs/art/concept (D-128).
const S: Record<string, string[]> = {
  idle0: ["..hh...", ".hHhh..", ".hhsse.", ".hhsss.", ".blbbB.", ".bbbbB.", ".ttttt.", ".BBBBB.", "..d.d..", "..d.d.."],
  idle1: [".......", "..hh...", ".hHhh..", ".hhsse.", ".blbbB.", ".bbbbB.", ".ttttt.", ".BBBBB.", "..d.d..", "..d.d.."],
  walk0: ["..hh...", ".hHhh..", ".hhsse.", ".hhsss.", ".blbbB.", "abbbbB.", ".ttttt.", ".BBBBB.", "..d.d..", "..d.d.."],
  walk1: [".......", "..hh...", ".hHhh..", ".hhsse.", ".blbbB.", ".bbabB.", ".ttttt.", ".BBBBB.", ".dd..d.", ".d...dd"],
  walk2: ["..hh...", ".hHhh..", ".hhsse.", ".hhsss.", ".blbbB.", ".bbbbBa", ".ttttt.", ".BBBBB.", "..d.d..", "..d.d.."],
  walk3: [".......", "..hh...", ".hHhh..", ".hhsse.", ".blbbB.", ".bbabB.", ".ttttt.", ".BBBBB.", ".d.dd..", "dd..d.."],
  jump: ["..hh...", ".hHhh.a", ".hhsse.", ".hhsssa", "ablbbBa", ".bbbbB.", ".ttttt.", ".BBBBB.", "..d.d..", ".d...d."],
  levitate: ["..hh...", ".hHhh..", ".hhsse.", ".hhsss.", "ablbbBa", ".bbbbB.", ".ttttt.", "..BBB..", "..ddd..", "...d..."],
  cast: ["..hh...", ".hHhh..", ".hhsse.", ".hhsss.", ".blbbaa", ".bbbBBg", ".ttttt.", ".BBBBB.", "..d.d..", ".dd.dd."],
  hit: [".......", "..hh...", ".hHhh..", "ahhsxe.", "abbbbB.", ".bbbbB.", "..tttt.", "..BBBB.", ".dd.dd.", ".d...d."],
};

// A dropped bag (5 wide, 5 tall): t cord, T band, p pouch, l light, q shade. A lobbed bomb (4 x 4): k casing, f highlight, q shade.
const BAG = ["..tt.", ".pTp.", "pplpp", "pppqp", ".qqq."];
const BOMB = [".kk.", "kfkk", "kkkq", ".qq."];
const BAG_COL: Record<string, [number, number, number]> = { t: [0.95, 0.8, 0.35], T: [0.85, 0.65, 0.25], p: [0.62, 0.42, 0.22], l: [0.78, 0.56, 0.32], q: [0.4, 0.26, 0.14] };
const BOMB_COL: Record<string, [number, number, number]> = { k: [0.16, 0.16, 0.2], f: [0.6, 0.6, 0.7], q: [0.08, 0.08, 0.11] };

function pushGrid(rects: Rect[], rows: string[], pal: Record<string, [number, number, number]>, x0: number, y0: number): void {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = pal[rows[y][x]];
      if (c) rects.push({ x: x0 + x, y: y0 + y, w: 1, h: 1, r: c[0], g: c[1], b: c[2] });
    }
  }
}

/** A bag resting on the cell (cx, cy): bobs by a cell now and then and glints. `now` is ms, cosmetic only. */
export function pushBag(rects: Rect[], cx: number, cy: number, now: number): void {
  const bob = Math.sin(now / 350 + cx * 0.7) > 0.4 ? 1 : 0;
  const x0 = Math.floor(cx) - 2;
  const y0 = Math.floor(cy) - 4 - bob;
  pushGrid(rects, BAG, BAG_COL, x0, y0);
  if (Math.floor(now / 160 + cx) % 9 === 0) rects.push({ x: x0 + 3, y: y0 + 1, w: 1, h: 1, r: 1, g: 1, b: 0.85 });
}

/** A bomb in flight: round shaded body, a short fuse and a flickering spark tip. */
export function pushBomb(rects: Rect[], x: number, y: number, now: number): void {
  const x0 = Math.round(x) - 2;
  const y0 = Math.round(y) - 2;
  pushGrid(rects, BOMB, BOMB_COL, x0, y0);
  rects.push({ x: x0 + 2, y: y0 - 1, w: 1, h: 1, r: 0.55, g: 0.4, b: 0.25 });
  const f = Math.floor(now / 60) % 3;
  rects.push({ x: x0 + 3 - (f === 1 ? 1 : 0), y: y0 - 2, w: 1, h: 1, r: 1, g: f === 0 ? 1 : f === 1 ? 0.7 : 0.45, b: f === 0 ? 0.7 : 0.15 });
}

const FIRE_A: RGB = [1, 0.45, 0.08];
const FIRE_B: RGB = [1, 0.6, 0.12];

/** A bolt body: bright core, a coloured shell and a flickering halo cell. `fire` uses the ember palette. */
export function pushBolt(rects: Rect[], x: number, y: number, c: [number, number, number], fire: boolean, now: number): void {
  const bx = Math.round(x);
  const by = Math.round(y);
  const f = Math.floor(now / 50 + x) & 1;
  const sh = fire ? (f ? FIRE_A : FIRE_B) : c;
  rects.push({ x: bx - 1, y: by - 1, w: 2, h: 2, r: sh[0], g: sh[1], b: sh[2] });
  rects.push({ x: bx - 1 + f, y: by - 2 + 3 * f, w: 1, h: 1, r: sh[0], g: sh[1] * 0.8, b: sh[2], a: 0.6 });
  rects.push({ x: bx - 1 + f, y: by - 1 + f, w: 1, h: 1, r: 1, g: 1, b: fire ? 0.7 : 1 });
}

const WALK = ["walk0", "walk1", "walk2", "walk3"];

const WHITE: [number, number, number] = [1, 1, 1];
const SKIN: [number, number, number] = [0.96, 0.82, 0.68];
const DARK: [number, number, number] = [0.1, 0.1, 0.14];
const BELT: [number, number, number] = [0.45, 0.3, 0.15];
type RGB = [number, number, number];
const lift = (c: RGB, m: number, add: number): RGB => [Math.min(1, c[0] * m + add), Math.min(1, c[1] * m + add), Math.min(1, c[2] * m + add)];

// One palette per player colour, built once (the colour arrays are long-lived), so drawing allocates nothing.
const PALETTES = new WeakMap<object, Record<string, RGB>>();
function paletteOf(body: RGB): Record<string, RGB> {
  let p = PALETTES.get(body);
  if (!p) {
    p = { h: lift(body, 0.55, 0), H: lift(body, 0.55, 0.22), s: SKIN, e: DARK, x: DARK, b: body, B: lift(body, 0.62, 0), l: lift(body, 0.7, 0.3), t: BELT, a: lift(body, 0.8, 0.1), d: lift(body, 0.35, 0) };
    PALETTES.set(body, p);
  }
  return p;
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
export function pushSprite(rects: Rect[], px: number, py: number, name: string, facingRight: boolean, body: RGB, glow: RGB = WHITE, t = 0): void {
  const rows = S[name] ?? S.idle0;
  const pal = paletteOf(body);
  const x0 = Math.round(px) - 3;
  const y0 = Math.round(py) - 10;
  for (let y = 0; y < rows.length; y++) {
    const row = facingRight ? rows[y] : [...rows[y]].reverse().join("");
    let x = 0;
    while (x < 7) {
      const ch = row[x];
      let n = 1;
      while (x + n < 7 && row[x + n] === ch) n++;
      const c = ch === "g" ? glow : pal[ch];
      if (c) rects.push({ x: x0 + x, y: y0 + y, w: n, h: 1, r: c[0], g: c[1], b: c[2] });
      x += n;
    }
  }
  if (name === "cast") {
    // A tight pulsing glow: the hand cell's neighbour on the arm side, plus a faint one above it.
    const hx = x0 + (facingRight ? 6 : 0);
    const k = 0.5 + 0.5 * Math.sin(t * 0.5);
    rects.push({ x: hx + (facingRight ? 1 : -1), y: y0 + 5, w: 1, h: 1, r: glow[0], g: glow[1], b: glow[2], a: 0.3 + 0.35 * k });
    rects.push({ x: hx, y: y0 + 4, w: 1, h: 1, r: glow[0], g: glow[1], b: glow[2], a: 0.1 + 0.2 * k });
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
  /** Colour of the last spell cast, for the hand glow. */
  castCol: [number, number, number];
  facingRight: boolean;
  pose: Pose;
}

export function newPoseState(x: number, y: number, facingRight: boolean): PoseState {
  return { x, y, vx: 0, vy: 0, walkPhase: 0, airMs: 0, castUntil: 0, hitUntil: 0, castCol: WHITE, facingRight, pose: "idle" };
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
    for (let i = 0; i < 3; i++) {
      const a = angle + (this.rand() - 0.5) * 0.6;
      const s = 0.03 + this.rand() * 0.03;
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 110, size: 1, r: c[0], g: c[1], b: c[2], grav: 0 });
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

  /** Fiery trail behind a Fire bolt: a hot puff that cools to red as it fades, plus the odd drifting ember. */
  fireTrail(x: number, y: number): void {
    const hot = this.rand();
    this.add({ x: x + (this.rand() - 0.5), y: y + (this.rand() - 0.5), vx: 0, vy: -0.004, life: 200 + hot * 160, size: 1, r: 1, g: 0.2 + hot * 0.6, b: 0.03 + hot * 0.1, grav: 0 });
    if (this.rand() < 0.3) this.add({ x, y, vx: (this.rand() - 0.5) * 0.02, vy: -0.005 - this.rand() * 0.015, life: 380 + this.rand() * 300, size: 1, r: 0.9, g: 0.2, b: 0.05, grav: 0.00002 });
  }

  /** Embers and fast sparks thrown up where a Fire bolt lands. */
  embers(x: number, y: number): void {
    for (let i = 0; i < 18; i++) {
      const a = -Math.PI / 2 + (this.rand() - 0.5) * 2.4;
      const s = 0.02 + this.rand() * 0.05;
      const hot = this.rand();
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 350 + this.rand() * 350, size: this.rand() < 0.25 ? 2 : 1, r: 1, g: 0.3 + hot * 0.55, b: 0.05, grav: 0.00005 });
    }
    for (let i = 0; i < 6; i++) {
      const a = this.rand() * Math.PI * 2;
      this.add({ x, y, vx: Math.cos(a) * 0.09, vy: Math.sin(a) * 0.09 - 0.03, life: 140 + this.rand() * 80, size: 1, r: 1, g: 1, b: 0.6, grav: 0.0002 });
    }
    this.add({ x, y, vx: 0, vy: 0, life: 90, size: 4, r: 1, g: 0.85, b: 0.5, grav: 0 });
  }

  /** A spark off a bomb's fuse (sparse). */
  fuseSpark(x: number, y: number): void {
    if (this.rand() < 0.5) this.add({ x, y, vx: (this.rand() - 0.5) * 0.03, vy: -0.01 - this.rand() * 0.02, life: 200, size: 1, r: 1, g: 0.85, b: 0.3, grav: 0.00004 });
  }

  /**
   * An explosion of the given radius in cells: a flash, an expanding ring and debris. Scaled so a bomb (18) is big and
   * gunpowder (4) small; the particle count is capped by radius and by the shared pool limit.
   */
  explosion(x: number, y: number, radius: number): void {
    const big = Math.min(1, radius / 18);
    this.add({ x, y, vx: 0, vy: 0, life: 70, size: Math.max(6, Math.round(radius * 1.2)), r: 1, g: 1, b: 0.9, grav: 0 });
    this.add({ x, y, vx: 0, vy: 0, life: 150, size: Math.max(4, Math.round(radius * 0.8)), r: 1, g: 0.8, b: 0.35, grav: 0 });
    const ring = 10 + Math.round(26 * big);
    const speed = (radius / 260) * 1.0; // the outer ring reaches about `radius` cells in 260 ms
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      const inner = i & 1;
      const sp = inner ? speed * 0.6 : speed;
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 260, size: 1, r: 1, g: inner ? 0.95 : 0.65, b: inner ? 0.6 : 0.2, grav: 0 });
    }
    const debris = 8 + Math.round(30 * big);
    for (let i = 0; i < debris; i++) {
      const a = this.rand() * Math.PI * 2;
      const s = speed * (0.3 + this.rand() * 0.9);
      const t = this.rand();
      // ember palette: yellow, orange, red, charred
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.01, life: 400 + this.rand() * 500, size: this.rand() < 0.3 ? 2 : 1, r: t < 0.75 ? 1 : 0.25, g: t < 0.25 ? 0.9 : t < 0.5 ? 0.5 : t < 0.75 ? 0.2 : 0.2, b: t < 0.75 ? 0.1 : 0.2, grav: 0.00006 });
    }
    const smoke = 3 + Math.round(6 * big);
    for (let i = 0; i < smoke; i++) {
      const a = this.rand() * Math.PI * 2;
      const g = 0.3 + this.rand() * 0.15;
      this.add({ x: x + Math.cos(a) * radius * 0.3, y: y + Math.sin(a) * radius * 0.3, vx: Math.cos(a) * speed * 0.15, vy: -0.012 - this.rand() * 0.012, life: 650 + this.rand() * 450, size: 2 + (this.rand() < 0.5 ? 1 : 0), r: g, g: g, b: g + 0.03, grav: 0 });
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
