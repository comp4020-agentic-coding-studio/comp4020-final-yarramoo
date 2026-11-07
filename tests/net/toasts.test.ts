// The death feed text is a pure function of a death event and a plain-name lookup.
import { describe, expect, it } from "vitest";
import { CAUSE_ACID, CAUSE_FIRE, CAUSE_GUNPOWDER, CAUSE_LAVA } from "../../shared/sim.ts";
import { formatDeath } from "../../client/toasts.ts";

const names: Record<number, string> = { 1: "Ana", 2: "Bo", 3: "Cy" };
const nameOf = (id: number) => names[id];
const d = (victim: number, killer: number, cause: number, bag = false) => formatDeath({ victim, killer, cause, bagDropped: bag }, nameOf);

describe("formatDeath", () => {
  it("each enemy kind has its own wording (cause 40 + kind)", () => {
    expect(d(1, 0, 41)).toBe("Ana was burned by an imp");
    expect(d(1, 0, 42)).toBe("Ana was dissolved by an acid slime");
    expect(d(1, 0, 43)).toBe("Ana was eaten by a worm");
    expect(d(1, 0, 44)).toBe("Ana was struck down by the Deep Mage");  });

  it("a slime death names the slime", () => {
    expect(d(1, 0, 40)).toBe("Ana was slain by a slime");
  });

  it("spell kills with a killer", () => {
    expect(d(2, 1, 5)).toBe("Ana blew up Bo (Bomb)");
    expect(d(2, 1, 4)).toBe("Ana torched Bo (Fire bolt)");
    expect(d(2, 1, 0)).toBe("Ana shoved Bo (Push)");
    expect(d(2, 1, 1)).toBe("Ana blasted Bo (Blast)");
    expect(d(2, 1, 2)).toBe("Ana drowned Bo (Water)");
    expect(d(2, 1, 3)).toBe("Ana pricked Bo (Rose)");
  });
  it("self kills read naturally", () => {
    expect(d(2, 2, 5)).toBe("Bo blew themselves up");
    expect(d(2, 2, 4)).toBe("Bo torched themselves");
  });
  it("no killer", () => {
    expect(d(2, 0, 5)).toBe("Bo was killed (Bomb)");
    expect(d(2, 0, CAUSE_FIRE)).toBe("Bo burned (Fire)");
    expect(d(3, 0, CAUSE_LAVA)).toBe("Cy fell in lava");
    expect(d(2, 0, CAUSE_GUNPOWDER)).toBe("Bo was blasted by gunpowder");
  });
  it("environment causes with a credited killer", () => {
    expect(d(2, 1, CAUSE_FIRE)).toBe("Ana burned Bo (Fire)");
    expect(d(2, 1, CAUSE_LAVA)).toBe("Ana sent Bo into lava");
    expect(d(2, 1, CAUSE_GUNPOWDER)).toBe("Ana blew up Bo (gunpowder)");
  });
  it("bag drop suffix", () => {
    expect(d(2, 1, 5, true)).toBe("Ana blew up Bo (Bomb) and dropped their bag");
    expect(d(3, 0, CAUSE_LAVA, true)).toBe("Cy fell in lava and dropped their bag");
  });
  it("unknown names and causes fall back to someone, never an id", () => {
    expect(d(9, 8, 5)).toBe("someone blew up someone (Bomb)");
    expect(d(9, 0, CAUSE_LAVA)).toBe("someone fell in lava");
    expect(d(2, 0, CAUSE_ACID)).toBe("Bo dissolved in acid");
    expect(d(2, 1, CAUSE_ACID)).toBe("Ana dissolved Bo in acid");
    expect(d(2, 0, 99)).toBe("Bo died");
    expect(d(9, 8, 5)).not.toMatch(/#|\d/);
  });
});

describe("formatAchievement", () => {
  it("takes the text from the shared table, never from the wire", async () => {
    const { formatAchievement } = await import("../../client/toasts.ts");
    expect(formatAchievement("waterworks")).toBe("Achievement: Waterworks · 100 Water casts");
    expect(formatAchievement("first_spell")).toBe("Achievement: First spell · Cast any spell");
    expect(formatAchievement("<img src=x onerror=alert(1)>")).toBeNull();
  });
});

import { NUM_ENEMY_KINDS, NUM_SPELLS } from "../../shared/sim.ts";
import { ENEMY_NAMES, youDiedText } from "../../client/toasts.ts";

describe("youDiedText", () => {
  const t = (cause: number, killer = 0) => youDiedText(cause, killer, 1, nameOf);
  it("has text for every spell, CAUSE_*, and enemy kind, never undefined", () => {
    for (let c = 0; c < NUM_SPELLS; c++) expect(t(c)).not.toMatch(/undefined/);
    for (const c of [CAUSE_FIRE, CAUSE_LAVA, CAUSE_GUNPOWDER, CAUSE_ACID, 0, 99]) expect(t(c, 2)).not.toMatch(/undefined|#/);
    expect(ENEMY_NAMES.length).toBe(NUM_ENEMY_KINDS);
    for (let k = 0; k < NUM_ENEMY_KINDS; k++) expect(t(40 + k)).toMatch(/^Killed by (a|an|the) /);
  });
  it("wording", () => {
    expect(t(41)).toBe("Killed by a Fire imp");
    expect(t(42)).toBe("Killed by an Acid slime");
    expect(t(44)).toBe("Killed by the Deep Mage");
    expect(t(5, 1)).toBe("Your own Bomb");
    expect(t(5, 2)).toBe("Killed by Bo's Bomb");
    expect(t(CAUSE_LAVA)).toBe("Burned in lava");
    expect(t(200)).toBe("You died");
  });
});

describe("bossName (the Survival lobby names the boss before the descent, Q4)", () => {
  it("names the two bosses and falls back for anything else", async () => {
    const { bossName } = await import("../../client/toasts.ts");
    expect(bossName(4)).toBe("the Deep Mage");
    expect(bossName(7)).toBe("the Sand Colossus");
    expect(bossName(null)).toBe("the boss");
    expect(bossName(0)).toBe("the boss");
  });
  it("every Survival world shows exactly one boss in the entities view at generation, before any step", async () => {
    const { wasmBytes } = await import("./helpers.ts");
    const { loadSim, ENT_ENEMY } = await import("../../shared/sim.ts");
    const { encodeConfig, SURVIVAL } = await import("../../shared/room.ts");
    const kinds = new Set<number>();
    for (const size of [0, 1]) {
      for (let seed = 1; seed <= 6; seed++) {
        const sim = loadSim(wasmBytes);
        sim.init(BigInt(seed), encodeConfig({ ...SURVIVAL, size }));
        const bosses = sim.entities().filter((e) => e.type === ENT_ENEMY && (e.sub === 4 || e.sub === 7));
        expect(bosses.length, `size ${size} seed ${seed}`).toBe(1);
        kinds.add(bosses[0].sub);
      }
    }
    expect([...kinds].sort()).toEqual([4, 7]); // both bosses occur over these seeds
  });
});
