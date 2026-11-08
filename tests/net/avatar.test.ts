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

  it("keeps sliding on ice after the key is released, and stops within a cell or two on rock", () => {
    const slide = (floor: number) => {
      const mat = new Uint8Array(W * H);
      for (let y = 100; y < H; y++) mat.fill(3, y * W, (y + 1) * W);
      for (let x = 20; x < 140; x++) mat[100 * W + x] = floor; // the walking surface: row 100
      const g: Grid = { mat, w: W, h: H };
      const a = new Avatar(30, 100);
      a.onGround = true;
      run(a, g, 60, { ...idle, right: true });
      const x0 = a.x;
      run(a, g, 200);
      return { x0, slid: a.x - x0, top: a.vx };
    };
    const ice = slide(18);
    const rock = slide(3);
    expect(rock.slid).toBeLessThan(2.5);
    expect(ice.slid).toBeGreaterThan(8);
    expect(ice.top).toBe(0); // the snap-to-zero still applies, so it does stop eventually
    expect(Math.abs(ice.x0 - 30)).toBeLessThan(MAX_SPEED_FIXED * 60 / 16 + 1); // no faster than walking
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

  it("lava is heavier than water: sinks at its own pace, slower walking, weaker swim-up (note 6)", () => {
    const deep = (m: number) => {
      const g = world();
      for (let y = 40; y < 100; y++) for (let x = 160; x < 180; x++) g.mat[y * W + x] = m; // a 60-deep pool
      return g;
    };
    const dive = (m: number, k = idle) => {
      const a = new Avatar(170, 60);
      run(a, deep(m), 30, k);
      return a;
    };
    const lava = dive(14);
    expect(lava.inLiquid).toBe(true);
    expect(lava.y).toBeGreaterThan(60); // it sinks into lava
    expect(lava.vy).toBeLessThan(0.35); // ...slowly: a lower top speed than water's 0.7
    expect(dive(5).vy).toBeGreaterThan(0.6); // water as before
    // Holding up in lava: a weak swim that does not lift you out like water does.
    const lift = (m: number) => {
      const a = new Avatar(170, 90);
      run(a, deep(m), 60, { ...idle, up: true });
      return 90 - a.y;
    };
    expect(lift(14)).toBeLessThan(lift(5) / 2);
    // Walking in lava is slower than in water.
    const wade = (m: number) => {
      const g = world();
      for (let y = 90; y < 100; y++) for (let x = 20; x < 120; x++) g.mat[y * W + x] = m;
      const a = new Avatar(20, 100);
      a.onGround = true;
      run(a, g, 60, { ...idle, right: true });
      return a.x - 20;
    };
    expect(wade(14)).toBeLessThan(wade(5) * 0.8);
    expect(SPEED_LIMIT_OK).toBe(true);
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
  const want = [E, S, S, S, S, L, S, S, S, S, G, G, G, S, L, L, L, G, S, S, S, S, S, S, S, S, S, S, S];
  it("pins every material id 0-28 to exactly one class", () => {
    expect(Object.keys(MATERIAL_NAMES).length).toBe(want.length);
    for (let m = 0; m < want.length; m++) {
      const got = m === 0 ? E : isSolid(m) ? S : isLiquid(m) ? L : isGas(m) ? G : "none";
      expect(got, `${m} ${MATERIAL_NAMES[m]}`).toBe(want[m]);
      if (m > 0) expect([isSolid(m), isLiquid(m), isGas(m)].filter(Boolean).length, `${m} exactly one`).toBe(1);
    }
  });
});
