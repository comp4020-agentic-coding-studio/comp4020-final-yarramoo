// Phone performance (Track C, 8 Nov). Pure helpers, no DOM, so tests/net/phone-perf.test.ts can pin them.
//
// Every world cell is drawn as a flat block: the camera sits on whole cells, every overlay rect is rounded to whole
// cells, and the fragment shader's colour is a function of the cell (render.ts). So a canvas whose backing store holds
// one pixel per cell, scaled up by CSS `image-rendering: pixelated`, shows the same picture as one holding DPR x k
// pixels per cell, at a fraction of the fragment work. On a 4x-throttled 390 x 844 phone at DPR 3 the menu's
// shader ran over 3.2 M pixels a frame and frames took 0.5-1 s (docs/research/phoneperf-report.md).

/** Backing-store size for a canvas showing `vw` x `vh` cells at `cssW` x `cssH` CSS pixels. `lean` (coarse pointers):
 * one pixel per cell, never more than the CSS size times the DPR. Otherwise the old size, CSS times DPR. */
export function backingSize(vw: number, vh: number, cssW: number, cssH: number, dpr: number, lean: boolean): { w: number; h: number } {
  const full = { w: Math.max(1, Math.round(cssW * dpr)), h: Math.max(1, Math.round(cssH * dpr)) };
  if (!lean) return full;
  return { w: Math.max(1, Math.min(full.w, Math.round(vw))), h: Math.max(1, Math.min(full.h, Math.round(vh))) };
}

/** Draw this frame? A cap of `minMs` between draws (0: every frame). Half a vsync of slack, so a 30 fps cap on a 60 Hz
 * display draws every other frame instead of drifting to every third. */
export function shouldDraw(now: number, lastDraw: number, minMs: number): boolean {
  return minMs <= 0 || now - lastDraw >= minMs - 8;
}

/** Menu routes whose panel covers (nearly) the whole backdrop on a phone, so drawing it is wasted. */
export function coversBackdrop(kind: string): boolean {
  return kind === "settings" || kind === "join" || kind === "share";
}

/** The game camera's window in cells. Desktop and landscape keep 480 x 270. A touch screen held upright shows 288 x 312:
 * 15% more rows and cells about 1.35 CSS px wide on a 390 px phone instead of 0.81 (the old view drew a cell smaller
 * than a pixel and left most of the screen empty). Height stays under the sim's 320-row active box (`ACTIVE_H`,
 * sim/src/tuning.rs), so the view never shows frozen chunks at its edges; both sides divide by 2 and 3 for zoom. */
export const PORTRAIT_VIEW = { w: 288, h: 312 };
export function gameView(base: { w: number; h: number }, touch: boolean, stageW: number, stageH: number): { w: number; h: number } {
  return touch && stageH > stageW ? PORTRAIT_VIEW : base;
}
