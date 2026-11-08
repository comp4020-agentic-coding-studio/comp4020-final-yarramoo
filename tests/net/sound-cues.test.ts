import { describe, expect, it } from "vitest";
import { CAUSE_ACID, CAUSE_FIRE, CAUSE_GUNPOWDER, CAUSE_LAVA, ENT_ENEMY, EV_EXPLODE, EV_IMPACT, EV_KNOCK, NUM_SPELLS } from "../../shared/sim.ts";
import { SPELL_SFX, damageSound, hurtCause, hurtClass, shouldPlayHurt, waterMotion, type WaterSamples } from "../../client/sound-cues.ts";

const W = 200, H = 200;
const grid = () => new Uint8Array(W * H);
const ME = 7;
// Feet at cell (100, 100): x16 = 1600, y16 = 1600. Chest is (100, 95).
const base = (over: Record<string, unknown> = {}) => ({
  events: [] as { kind: number; player: number; a: number; b: number; c: number }[],
  ents: [] as { type: number; id: number; active: boolean; sub: number; x: number; y: number }[],
  myId: ME, x: 1600, y: 1600, mat: grid(), w: W, h: H, ...over,
});

describe("hurtCause", () => {
  it("returns null with nothing around", () => expect(hurtCause(base())).toBeNull());
  it("explosions: enemy owner, gunpowder, bomb", () => {
    const ex = (player: number) => [{ kind: EV_EXPLODE, player, a: 100, b: 95, c: 6 }];
    expect(hurtCause(base({ events: ex(((0x80000000 | (2 << 16) | 5) >>> 0)) }))).toBe(42);
    expect(hurtCause(base({ events: ex(0) }))).toBe(CAUSE_GUNPOWDER);
    expect(hurtCause(base({ events: ex(3) }))).toBe(5);
    expect(hurtCause(base({ events: [{ kind: EV_EXPLODE, player: 3, a: 150, b: 95, c: 6 }] }))).toBeNull(); // too far
  });
  it("fire bolt impact near me", () => {
    expect(hurtCause(base({ events: [{ kind: EV_IMPACT, player: 3, a: 102, b: 96, c: 4 }] }))).toBe(4);
    expect(hurtCause(base({ events: [{ kind: EV_IMPACT, player: ((0x80000000 | (1 << 16)) >>> 0), a: 102, b: 96, c: 4 }] }))).toBe(41);
    expect(hurtCause(base({ events: [{ kind: EV_IMPACT, player: 3, a: 102, b: 96, c: 2 }] }))).toBeNull();
    expect(hurtCause(base({ events: [{ kind: EV_IMPACT, player: 3, a: 140, b: 96, c: 4 }] }))).toBeNull();
  });
  it("contact knock names the nearest enemy", () => {
    const events = [{ kind: EV_KNOCK, player: ME, a: 40, b: -24, c: 0 }];
    const ents = [
      { type: ENT_ENEMY, id: 1, active: true, sub: 6, x: 3200, y: 1600 },
      { type: ENT_ENEMY, id: 2, active: true, sub: 3, x: 1700, y: 1600 },
    ];
    expect(hurtCause(base({ events, ents }))).toBe(43);
    expect(hurtCause(base({ events: [{ kind: EV_KNOCK, player: ME, a: 12, b: -24, c: 0 }], ents }))).toBeNull();
  });
  it("hitbox contents: lava over fire over acid", () => {
    const g = grid();
    g[95 * W + 100] = 16;
    expect(hurtCause(base({ mat: g }))).toBe(CAUSE_ACID);
    g[96 * W + 100] = 10;
    expect(hurtCause(base({ mat: g }))).toBe(CAUSE_FIRE);
    g[97 * W + 100] = 14;
    expect(hurtCause(base({ mat: g }))).toBe(CAUSE_LAVA);
  });
});

describe("damageSound", () => {
  it("maps causes to distinct names", () => {
    expect(damageSound(CAUSE_LAVA)).toBe("sizzle");
    expect(damageSound(CAUSE_FIRE)).toBe("burn");
    expect(damageSound(CAUSE_ACID)).toBe("corrode");
    expect(damageSound(CAUSE_GUNPOWDER)).toBe("powderhit");
    expect(damageSound(5)).toBe("blasthit");
    expect(damageSound(4)).toBe("bolthit");
    expect(damageSound(2)).toBe("hurt");
    expect(damageSound(null)).toBe("hurt");
    expect(damageSound(99)).toBe("hurt");
    const enemies = [40, 41, 42, 43, 44, 45, 46, 47].map(damageSound);
    expect(enemies).toEqual(["slimehit", "imphit", "acidhit", "wormbite", "magehit", "wisphit", "frosthit", "colossushit"]);
  });
});

describe("rate limit", () => {
  it("classes", () => {
    expect(hurtClass(CAUSE_LAVA)).toBe("hazard");
    expect(hurtClass(CAUSE_FIRE)).toBe("hazard");
    expect(hurtClass(CAUSE_ACID)).toBe("hazard");
    expect(hurtClass(5)).toBe("hit");
    expect(hurtClass(41)).toBe("hit");
    expect(hurtClass(null)).toBe("hit");
  });
  it("hazards share one 280 ms gap, hits 120 ms", () => {
    const last = { hazard: 1000, hit: 1000 };
    expect(shouldPlayHurt("hazard", 1279, last)).toBe(false);
    expect(shouldPlayHurt("hazard", 1280, last)).toBe(true);
    expect(shouldPlayHurt("hit", 1119, last)).toBe(false);
    expect(shouldPlayHurt("hit", 1120, last)).toBe(true);
  });
});

describe("SPELL_SFX", () => {
  it("has 15 distinct entries", () => {
    expect(SPELL_SFX.length).toBe(NUM_SPELLS);
    expect(new Set(SPELL_SFX).size).toBe(NUM_SPELLS);
    expect(SPELL_SFX[7]).toBe("acidflask");
    expect(SPELL_SFX[14]).toBe("mudslide");
  });
});

describe("waterMotion", () => {
  const win = { x: 50, y: 50, w: 100, h: 80 };
  const block = (g: Uint8Array, x0: number, y0: number, bw: number, bh: number) => {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) g[y * W + x] = 5;
  };
  const run = (g1: Uint8Array, g2: Uint8Array, w2 = win, cx = 100, cy = 90) => {
    const a = waterMotion(g1, W, H, win, 2, null, cx, cy);
    return waterMotion(g2, W, H, w2, 2, a.next as WaterSamples, cx, cy);
  };
  it("still water reads 0", () => {
    const g = grid(); block(g, 60, 100, 60, 20);
    expect(run(g, g).level).toBe(0);
  });
  it("a falling mass reads above 0, more water reads higher", () => {
    const a = grid(), b = grid(); block(a, 90, 70, 12, 12); block(b, 90, 73, 12, 12);
    const big1 = grid(), big2 = grid(); block(big1, 70, 60, 40, 20); block(big2, 70, 63, 40, 20);
    const small = run(a, b).level, big = run(big1, big2).level;
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });
  it("the same motion farther away reads lower", () => {
    const a = grid(), b = grid(); block(a, 90, 70, 20, 20); block(b, 90, 73, 20, 20);
    const near = run(a, b, win, 100, 80).level;
    const a2 = grid(), b2 = grid(); block(a2, 56, 70, 20, 20); block(b2, 56, 73, 20, 20);
    const far = run(a2, b2, win, 140, 80).level;
    expect(far).toBeLessThan(near);
  });
  it("a moving camera over still water reads 0", () => {
    const g = grid(); block(g, 60, 90, 80, 30);
    expect(run(g, g, { x: 53, y: 51, w: 100, h: 80 }).level).toBe(0);
  });
  it("a handful of changed cells (a drip) reads 0", () => {
    const a = grid(), b = grid(); block(a, 90, 70, 2, 2); block(b, 90, 72, 2, 2);
    expect(run(a, b).level).toBe(0);
  });
});
