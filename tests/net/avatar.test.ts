// The avatar controller against a hand-made grid: gravity, walking, steps, jumping, levitation, liquids.
import { describe, expect, it } from "vitest";
import { Avatar, ENERGY_MAX, MAX_SPEED_FIXED, SPEED_LIMIT_OK, type Grid } from "../../client/avatar.ts";
import { MAX_AVATAR_SPEED } from "../../shared/avatar.ts";

const W = 200;
const H = 120;
/** A flat floor at row 100 (solid from y = 100 down) with a 2-cell bump, a wall at x = 150 and a pool. */
function world(): Grid {
  const mat = new Uint8Array(W * H);
  for (let y = 100; y < H; y++) mat.fill(3, y * W, (y + 1) * W);
  for (let y = 98; y < 100; y++) for (let x = 60; x < 64; x++) mat[y * W + x] = 3; // bump 2 high
  for (let y = 0; y < 100; y++) mat[y * W + 150] = 2; // wall
  for (let y = 100; y < 108; y++) for (let x = 160; x < 180; x++) mat[y * W + x] = 5; // pool carved into the floor
  return { mat, w: W, h: H };
}
const idle = { left: false, right: false, up: false };
const run = (a: Avatar, g: Grid, n: number, k = idle) => {
  for (let i = 0; i < n; i++) a.step(k, g);
};

describe("avatar controller", () => {
  it("stays under the speed the server validates against", () => {
    expect(SPEED_LIMIT_OK).toBe(true);
    expect(MAX_SPEED_FIXED).toBeLessThan(MAX_AVATAR_SPEED);
  });

  it("falls onto the floor and stands there on a 1/16 grid", () => {
    const g = world();
    const a = new Avatar(20, 80);
    run(a, g, 120);
    expect(a.y).toBe(100);
    expect(a.onGround).toBe(true);
    expect(a.x * 16).toBe(Math.round(a.x * 16));
  });

  it("walks, steps over a 2-cell bump, and is stopped by a wall", () => {
    const g = world();
    const a = new Avatar(40, 100);
    a.onGround = true;
    run(a, g, 80, { ...idle, right: true });
    expect(a.x).toBeGreaterThan(70); // past the bump at x 60..63
    expect(a.facing).toBe(1);
    run(a, g, 300, { ...idle, right: true });
    expect(a.x).toBeLessThanOrEqual(150 - 2.5); // wall at x = 150
    expect(a.x).toBeGreaterThan(145);
    run(a, g, 300, { ...idle, left: true });
    expect(a.facing).toBe(0);
    expect(a.x).toBeLessThan(145);
  });

  it("jumps from the ground and levitates in the air for a limited time, recharging on the ground", () => {
    const g = world();
    const a = new Avatar(20, 100);
    run(a, g, 5);
    let top = 100;
    for (let i = 0; i < 20; i++) {
      a.step({ ...idle, up: true }, g);
      top = Math.min(top, a.y);
    }
    expect(top).toBeLessThan(90);
    // Keep holding up: energy runs out, and the climb is bounded however long it is held.
    let min = 100;
    let drained = false;
    for (let i = 0; i < 400; i++) {
      a.step({ ...idle, up: true }, g);
      min = Math.min(min, a.y);
      drained ||= a.energy === 0;
    }
    expect(drained).toBe(true);
    expect(min).toBeLessThan(30); // it climbed (to the test world's ceiling)
    expect(a.y).toBeGreaterThan(95); // and with the tank empty it came back down
    run(a, g, 300);
    expect(a.energy).toBe(ENERGY_MAX);
  });

  it("cannot leave the world and is blocked by the ceiling", () => {
    const g = world();
    const a = new Avatar(20, 30);
    for (let i = 0; i < 600; i++) a.step({ ...idle, up: true }, g);
    expect(a.y).toBeGreaterThanOrEqual(10);
    expect(a.energy).toBeLessThan(ENERGY_MAX);
  });

  it("liquids do not block but slow: sinks slowly, can swim up, gases do not block", () => {
    const g = world();
    const a = new Avatar(170, 90);
    run(a, g, 90);
    expect(a.y).toBeGreaterThan(100); // sank into the pool
    expect(a.inLiquid).toBe(true);
    expect(Math.abs(a.vy)).toBeLessThan(1);
    run(a, g, 120, { ...idle, up: true });
    expect(a.y).toBeLessThan(100); // swam out
    // Fire in the way does not block.
    const g2 = world();
    for (let y = 90; y < 100; y++) g2.mat[y * W + 30] = 10;
    const b = new Avatar(20, 100);
    b.onGround = true;
    run(b, g2, 60, { ...idle, right: true });
    expect(b.x).toBeGreaterThan(32);
  });

  it("speed never exceeds the limit over a long random run", () => {
    const g = world();
    const a = new Avatar(100, 50);
    let px = a.x;
    let py = a.y;
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      a.step({ left: (i >> 5) % 3 === 0, right: (i >> 5) % 3 === 1, up: (i >> 4) % 5 < 2 }, g);
      worst = Math.max(worst, Math.abs(a.x - px) * 16, Math.abs(a.y - py) * 16);
      px = a.x;
      py = a.y;
    }
    expect(worst).toBeLessThan(MAX_AVATAR_SPEED);
  });
});

// Every material id pinned to how the controller treats it. A new material must be added here and in
// MATERIAL_CLASS (shared/names.ts), or the first assertion fails.
import { isGas, isLiquid, isSolid } from "../../client/avatar.ts";
import { MATERIAL_NAMES } from "../../shared/names.ts";

describe("avatar material classes", () => {
  const E = "empty", S = "solid", L = "liquid", G = "gas";
  const want = [E, S, S, S, S, L, S, S, S, S, G, G, G, S, L, L, L, G, S, S, S];
  it("pins every material id 0-20 to exactly one class", () => {
    expect(Object.keys(MATERIAL_NAMES).length).toBe(want.length);
    for (let m = 0; m < want.length; m++) {
      const got = m === 0 ? E : isSolid(m) ? S : isLiquid(m) ? L : isGas(m) ? G : "none";
      expect(got, `${m} ${MATERIAL_NAMES[m]}`).toBe(want[m]);
      if (m > 0) expect([isSolid(m), isLiquid(m), isGas(m)].filter(Boolean).length, `${m} exactly one`).toBe(1);
    }
  });
});
