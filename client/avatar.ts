// Avatar controller (plan 8). TypeScript, floats allowed, LOCAL ONLY: it predicts the player's own avatar and
// never writes simulation state. Its position leaves the client only as quantised Pos inputs (1/16 cell), which
// the sim applies as the "official" position. Collision reads the latest simulated grid and nothing else.
//
// Material rules (D-063): SOLID blocks (Rock, Dirt, Sand and the other powders, Wood, plants, Bedrock);
// GASES (Fire, Smoke, Steam, marsh Gas) never block; LIQUIDS (Water, Lava, Oil, Acid) never block but slow you
// and let you swim. The classes live in MATERIAL_CLASS (shared/names.ts).
// Lava is only slowing here: damage is the sim's job in M5.
import { MAX_AVATAR_SPEED, POS_ONE } from "../shared/avatar.ts";
import { MATERIAL_CLASS } from "../shared/names.ts";

export const BOX_W = 5;
export const BOX_H = 10;
const STEP = 1 / POS_ONE;

// Cells per tick (60 Hz). Every speed stays well under MAX_AVATAR_SPEED / 16 = 3 cells per tick, which the
// server validates Pos jumps against.
export const WALK = 0.75;
export const GRAVITY = 0.12;
export const TERMINAL = 2.4;
export const JUMP = 1.9;
export const THRUST = 0.24;
export const RISE_MAX = 1.1;
export const ENERGY_MAX = 90;
const ENERGY_REGEN = 2;
const MAX_STEP_UP = 3;

const EMPTY = 0;

export interface Grid {
  mat: Uint8Array;
  w: number;
  h: number;
}
export interface Keys {
  left: boolean;
  right: boolean;
  /** W, arrow up or space: jump on the ground, levitate in the air. */
  up: boolean;
}

export const isGas = (m: number): boolean => MATERIAL_CLASS[m] === "gas";
export const isLiquid = (m: number): boolean => MATERIAL_CLASS[m] === "liquid";
export const isSolid = (m: number): boolean => m !== EMPTY && !isGas(m) && !isLiquid(m);

export class Avatar {
  /** Feet centre in cells (multiples of 1/16). */
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  energy = ENERGY_MAX;
  onGround = false;
  inLiquid = false;
  facing = 1;
  private remX = 0;
  private remY = 0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  teleport(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = this.vy = this.remX = this.remY = 0;
  }

  /**
   * A Knock event from the sim (plan 6.7): `vx`, `vy` in 1/16 cell per tick. The sim does not move players,
   * so the victim's own controller takes the impulse and the result reaches everyone through its Pos inputs.
   * Added to the current velocity and capped per axis so the Pos jump check still holds.
   */
  knock(vx: number, vy: number): void {
    const cap = (MAX_AVATAR_SPEED + 96) / POS_ONE - 0.01;
    this.vx = Math.max(-cap, Math.min(cap, this.vx + vx / POS_ONE));
    this.vy = Math.max(-cap, Math.min(cap, this.vy + vy / POS_ONE));
    if (vy < 0) this.onGround = false;
  }

  /** Does the 5 x 10 box with feet centre (x, y) overlap a solid cell? Out of the world counts as solid. */
  collides(g: Grid, x: number, y: number): boolean {
    const x0 = Math.floor(x - BOX_W / 2);
    const x1 = Math.ceil(x + BOX_W / 2) - 1;
    const y0 = Math.floor(y - BOX_H);
    const y1 = Math.ceil(y) - 1;
    if (x0 < 0 || y0 < 0 || x1 >= g.w || y1 >= g.h) return true;
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * g.w;
      for (let cx = x0; cx <= x1; cx++) if (isSolid(g.mat[row + cx])) return true;
    }
    return false;
  }

  private liquidAt(g: Grid): boolean {
    // Body centre and feet rows, middle column: enough to tell wading from swimming.
    const cx = Math.floor(this.x);
    for (const dy of [-1, -5]) {
      const cy = Math.floor(this.y + dy);
      if (cy >= 0 && cy < g.h && cx >= 0 && cx < g.w && isLiquid(g.mat[cy * g.w + cx])) return true;
    }
    return false;
  }

  /** One 60 Hz tick of the controller. */
  step(k: Keys, g: Grid): void {
    this.inLiquid = this.liquidAt(g);
    const dir = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    if (dir) this.facing = dir > 0 ? 1 : 0;
    const walk = this.inLiquid ? WALK * 0.55 : WALK;
    this.vx += (dir * walk - this.vx) * (this.onGround || this.inLiquid ? 0.4 : 0.15);
    if (!dir && Math.abs(this.vx) < 0.02) this.vx = 0;

    // Vertical: jump from the ground, levitate while up is held in the air (limited energy), swim in liquid.
    if (this.inLiquid) {
      this.vy += GRAVITY * 0.35;
      if (k.up) this.vy -= 0.2;
      this.vy = Math.max(-0.9, Math.min(0.7, this.vy));
    } else {
      if (k.up && this.onGround) {
        this.vy = -JUMP;
        this.onGround = false;
      } else if (k.up && !this.onGround && this.energy > 0) {
        this.vy = Math.max(-RISE_MAX, this.vy - THRUST);
        this.energy = Math.max(0, this.energy - 1);
      }
      this.vy = Math.min(TERMINAL, this.vy + GRAVITY);
    }
    if (this.onGround) this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_REGEN);

    this.moveX(g);
    this.moveY(g);
    this.onGround = this.vy >= 0 && this.collides(g, this.x, this.y + STEP);
  }

  private moveX(g: Grid): void {
    this.remX += this.vx;
    const n = Math.trunc(this.remX * POS_ONE);
    this.remX -= n * STEP;
    const s = Math.sign(n);
    for (let i = 0; i < Math.abs(n); i++) {
      const nx = this.x + s * STEP;
      if (!this.collides(g, nx, this.y)) {
        this.x = nx;
        continue;
      }
      // Walk over a small bump: step up to MAX_STEP_UP cells if there is room.
      let up = 0;
      if (this.onGround) for (let u = 1; u <= MAX_STEP_UP && !up; u++) if (!this.collides(g, nx, this.y - u)) up = u;
      if (up) {
        this.x = nx;
        this.y -= up;
      } else {
        this.vx = 0;
        this.remX = 0;
        return;
      }
    }
  }

  private moveY(g: Grid): void {
    this.remY += this.vy;
    const n = Math.trunc(this.remY * POS_ONE);
    this.remY -= n * STEP;
    const s = Math.sign(n);
    for (let i = 0; i < Math.abs(n); i++) {
      const ny = this.y + s * STEP;
      if (this.collides(g, this.x, ny)) {
        this.vy = 0;
        this.remY = 0;
        return;
      }
      this.y = ny;
    }
  }

  /** Fixed-point Pos fields: quantised to 1/16 cell. */
  quantised(): { x: number; y: number; facing: number } {
    return { x: Math.round(this.x * POS_ONE), y: Math.round(this.y * POS_ONE), facing: this.facing };
  }
}

/** The highest speed (1/16 cell per tick) the controller can ever reach, for the check against the server's limit. */
export const MAX_SPEED_FIXED = Math.max(WALK, TERMINAL, JUMP, RISE_MAX) * POS_ONE;
export const SPEED_LIMIT_OK = MAX_SPEED_FIXED < MAX_AVATAR_SPEED;
