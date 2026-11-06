// Guard for the menu backdrop (W3): the constants in client/menu/backdrop-config.ts were found offline for one
// generator. If a generator or enemy change empties a window, the menu would silently show a dead landscape.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSim, ENT_ENEMY, ENT_PLAYER, type Sim } from "../../shared/sim.ts";
import { encodeConfig } from "../../shared/room.ts";
import { encodeJoin, encodePos } from "../../shared/inputs.ts";
import { MENU_BACKDROP, MENU_SEED, VIGNETTES, WINDOW_H, WINDOW_W } from "../../client/menu/backdrop-config.ts";

const bytes = new Uint8Array(readFileSync("sim/target/wasm32-unknown-unknown/release/sim.wasm"));
const FLIERS = new Set([1, 5, 6]);
const BOSSES = new Set([4, 7]);

function fresh(): Sim {
  const sim = loadSim(bytes);
  sim.init(BigInt(MENU_SEED), encodeConfig(MENU_BACKDROP));
  return sim;
}
const inWin = (v: (typeof VIGNETTES)[number], e: { x: number; y: number }) =>
  e.x / 16 >= v.camX && e.x / 16 < v.camX + WINDOW_W && e.y / 16 >= v.camY && e.y / 16 < v.camY + WINDOW_H;

describe("menu backdrop world", () => {
  it("has vignettes and inits (the config passes the sim's decode)", () => {
    expect(VIGNETTES.length).toBeGreaterThanOrEqual(3);
    const sim = fresh();
    expect(sim.width()).toBeGreaterThan(512); // the worker draws mobs only in a game-size world
  });

  VIGNETTES.forEach((v, i) => {
    it(`vignette ${i}: >= 3 enemies, a flier, no boss at tick 0`, () => {
      const en = fresh().entities().filter((e) => e.type === ENT_ENEMY && inWin(v, e));
      const summary = `window ${i}: ${en.length} enemies, kinds [${en.map((e) => e.sub).join(",")}]`;
      expect(en.length, summary).toBeGreaterThanOrEqual(3);
      expect(en.filter((e) => FLIERS.has(e.sub)).length, summary).toBeGreaterThanOrEqual(1);
      expect(en.filter((e) => BOSSES.has(e.sub)).length, summary).toBe(0);
    });

    it(`vignette ${i}: enemies move once the explorer arrives`, () => {
      const sim = fresh();
      sim.pushInput(encodeJoin(1));
      sim.step();
      const me = sim.entities().find((e) => e.type === ENT_PLAYER && e.id === 1);
      expect(me, "explorer joined").toBeTruthy();
      const before = new Map(sim.entities().filter((e) => e.type === ENT_ENEMY && inWin(v, e)).map((e) => [e.id, `${e.x},${e.y}`]));
      for (let t = 0; t < 300; t++) {
        if (t % 2 === 0) sim.pushInput(encodePos(1, me!.a, v.x * 16, v.y * 16, 1));
        sim.step();
      }
      const moved = sim.entities().filter((e) => e.type === ENT_ENEMY && before.has(e.id) && before.get(e.id) !== `${e.x},${e.y}`).length;
      expect(moved, `window ${i}: ${moved} of ${before.size} moved`).toBeGreaterThanOrEqual(2);
    });
  });
});
