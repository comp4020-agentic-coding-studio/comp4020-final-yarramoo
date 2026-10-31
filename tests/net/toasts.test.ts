// The death feed text is a pure function of a death event and a plain-name lookup.
import { describe, expect, it } from "vitest";
import { CAUSE_ACID, CAUSE_FIRE, CAUSE_GUNPOWDER, CAUSE_LAVA } from "../../shared/sim.ts";
import { formatDeath } from "../../client/toasts.ts";

const names: Record<number, string> = { 1: "Ana", 2: "Bo", 3: "Cy" };
const nameOf = (id: number) => names[id];
const d = (victim: number, killer: number, cause: number, bag = false) => formatDeath({ victim, killer, cause, bagDropped: bag }, nameOf);

describe("formatDeath", () => {
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
