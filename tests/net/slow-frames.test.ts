// N1 (8 Nov): the worker steps the sim from requestAnimationFrame on an OffscreenCanvas, which follows the page's frame
// rate. A 4x-throttled page (about a phone) ran it at ~10 Hz. With 4 steps a frame (+ MAX_EXTRA) and a 12 ms fast-forward
// budget, the client could not keep up with 60 ticks/s and never caught up once behind. A pure model of that client:
// fake time, a server adding 60 ticks/s, steps that cost 2 ms each, frames 100 ms apart, the worker's own policy.
import { describe, expect, it } from "vitest";
import { Lockstep, MAX_FRAME_STEPS, MAX_STEP_DT_MS, driveFrame, ffBudgetMs } from "../../client/lockstep.ts";
import type { Sim } from "../../shared/sim.ts";

function fakeSim(clock: { t: number }, stepMs: number): Sim {
  let tick = 0;
  return { tick: () => tick, step: () => { clock.t += stepMs; tick++; return 0; }, pushInput: () => 0 } as unknown as Sim;
}

/** Run `seconds` of a client at `fps` whose steps cost `stepMs`; returns how far behind the server it ends. */
function run(fps: number, stepMs: number, seconds: number, startBehind: number): { behind: number; catching: boolean } {
  const clock = { t: 0 };
  const ls = new Lockstep(fakeSim(clock, stepMs));
  let server = 0;
  const addTo = (t: number) => { while (server < Math.floor((t * 60) / 1000)) ls.push(++server, []); };
  clock.t = (startBehind * 1000) / 60;
  addTo(clock.t);
  let acc = 0;
  let catching = false;
  const dt = 1000 / fps;
  let frameStart = clock.t;
  const STEP_MS = 1000 / 60;
  while (clock.t < (seconds * 1000)) {
    const stepDt = Math.min(dt, MAX_STEP_DT_MS);
    const base = Math.min(Math.floor((acc += stepDt) / STEP_MS), MAX_FRAME_STEPS);
    if (catching) acc = 0;
    else acc -= Math.floor(acc / STEP_MS) * STEP_MS;
    const r = driveFrame(ls, catching, base, ffBudgetMs(stepDt), () => clock.t);
    if (r.entered || (catching && !r.catching)) acc = 0;
    catching = r.catching;
    // The rest of the frame (render, main thread): time passes whatever the stepping cost.
    frameStart += dt;
    if (clock.t < frameStart) clock.t = frameStart;
    addTo(clock.t);
  }
  return { behind: server - ls.simTick, catching };
}

describe("a slow client (low frame rate, slow steps) keeps up with 60 ticks/s", () => {
  it("stays live at 7 frames/s (the throttled page's worst gaps) with 2 ms steps", () => {
    const r = run(7, 2, 60, 0);
    expect(r.catching).toBe(false);
    expect(r.behind).toBeLessThan(30);
  });
  it("stays live at 3 frames/s (three pages in one browser, 4x throttled) with 2 ms steps", () => {
    const r = run(3, 2, 60, 0);
    expect(r.catching).toBe(false);
    expect(r.behind).toBeLessThan(60);
  });
  it("catches up from 3000 ticks behind at 10 frames/s", () => {
    const r = run(10, 2, 120, 3000);
    expect(r.catching).toBe(false);
    expect(r.behind).toBeLessThan(30);
  });
  it("catches up from 1000 behind at 3 frames/s with 8 ms steps (most of a long frame goes to the replay)", () => {
    const r = run(3, 8, 120, 1000);
    expect(r.catching).toBe(false);
    expect(r.behind).toBeLessThan(60);
  });
  it("a normal 60 fps client is unchanged: live, a few ticks behind", () => {
    const r = run(60, 0.5, 30, 0);
    expect(r.catching).toBe(false);
    expect(r.behind).toBeLessThan(10);
  });
});
