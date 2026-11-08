// Track C (8 Nov): phone draw cost. The helpers in client/phone.ts decide the canvas backing size on touch devices, the
// menu backdrop's draw cap and which menu screens pause it. The frame-time numbers are in tests/soak/phone-perf.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backingSize, coversBackdrop, gameView, PORTRAIT_VIEW, shouldDraw } from "../../client/phone.ts";

describe("backingSize", () => {
  it("is CSS x DPR when not lean (desktop unchanged)", () => {
    expect(backingSize(480, 270, 960, 540, 2, false)).toEqual({ w: 1920, h: 1080 });
  });
  it("is one pixel per cell on a phone (390 px wide at DPR 3, a 480 x 270 view)", () => {
    expect(backingSize(480, 270, 390, 219, 3, true)).toEqual({ w: 480, h: 270 });
  });
  it("never exceeds CSS x DPR (a view drawn smaller than one CSS pixel per cell)", () => {
    expect(backingSize(480, 270, 120, 68, 1, true)).toEqual({ w: 120, h: 68 });
  });
  it("cuts the menu backdrop's pixels at least 50x at 390 x 844, DPR 3", () => {
    const full = backingSize(130, 282, 390, 846, 3, false);
    const lean = backingSize(130, 282, 390, 846, 3, true);
    expect((full.w * full.h) / (lean.w * lean.h)).toBeGreaterThanOrEqual(50);
  });
});

describe("shouldDraw", () => {
  it("draws every frame with no cap", () => {
    expect(shouldDraw(1000, 990, 0)).toBe(true);
  });
  it("at a 30 fps cap on a 60 Hz display, draws every other frame", () => {
    let last = -Infinity;
    let drawn = 0;
    for (let i = 0; i < 60; i++) {
      const now = i * (1000 / 60);
      if (shouldDraw(now, last, 1000 / 30)) {
        drawn++;
        last = now;
      }
    }
    expect(drawn).toBe(30);
  });
});

describe("coversBackdrop", () => {
  it("pauses behind settings, join and share; keeps the title and type picker live", () => {
    expect(["settings", "join", "share"].map(coversBackdrop)).toEqual([true, true, true]);
    expect(["title", "types"].map(coversBackdrop)).toEqual([false, false]);
  });
});

describe("wiring", () => {
  it("the room and the menu backdrop both size their canvas through backingSize, and the worker honours drawMs", () => {
    expect(readFileSync("client/room.ts", "utf8")).toMatch(/backingSize\(/);
    expect(readFileSync("client/menu-preview.ts", "utf8")).toMatch(/backingSize\(/);
    expect(readFileSync("client/menu-preview.ts", "utf8")).toMatch(/coversBackdrop\(/);
    expect(readFileSync("client/worker.ts", "utf8")).toMatch(/shouldDraw\(/);
  });
});

describe("gameView (portrait camera)", () => {
  const BASE = { w: 480, h: 270 };
  it("keeps 480 x 270 on desktop and in landscape", () => {
    expect(gameView(BASE, false, 390, 700)).toEqual(BASE);
    expect(gameView(BASE, true, 844, 300)).toEqual(BASE);
  });
  it("shows more rows and bigger cells on an upright touch screen", () => {
    const v = gameView(BASE, true, 390, 700);
    expect(v.h).toBeGreaterThan(BASE.h);
    expect(390 / v.w).toBeGreaterThan(1.3);
  });
  it("stays inside the sim's active box and divides by every zoom level", () => {
    const tuning = readFileSync("sim/src/tuning.rs", "utf8");
    const aw = Number(/pub const ACTIVE_W: i32 = (\d+);/.exec(tuning)![1]);
    const ah = Number(/pub const ACTIVE_H: i32 = (\d+);/.exec(tuning)![1]);
    expect(PORTRAIT_VIEW.w).toBeLessThanOrEqual(aw);
    expect(PORTRAIT_VIEW.h).toBeLessThanOrEqual(ah);
    for (const z of [1, 2, 3]) expect([PORTRAIT_VIEW.w % z, PORTRAIT_VIEW.h % z]).toEqual([0, 0]);
  });
  it("the room's camera goes through gameView", () => {
    expect(readFileSync("client/room.ts", "utf8")).toMatch(/gameView\(/);
  });
});

describe("portrait fill", () => {
  it("a lean (touch) canvas scales to fit the stage instead of flooring to a whole multiple", () => {
    expect(readFileSync("client/room.ts", "utf8")).toMatch(/const scale = k >= 1 && !leanCanvas \? k : fit;/);
  });
});
