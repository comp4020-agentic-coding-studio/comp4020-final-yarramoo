// Track C (8 Nov): phone draw cost. The helpers in client/phone.ts decide the canvas backing size on touch devices, the
// menu backdrop's draw cap and which menu screens pause it. The frame-time numbers are in tests/soak/phone-perf.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backingSize, coversBackdrop, shouldDraw } from "../../client/phone.ts";

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
