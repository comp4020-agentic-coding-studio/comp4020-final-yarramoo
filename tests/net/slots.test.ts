import { describe, expect, it } from "vitest";
import { addPickedUp, swapSlots } from "../../client/slots.ts";
import { BAR, INFINITE } from "../../client/spells.ts";

const charges = (m: Record<number, number>) => Array.from({ length: 12 }, (_, i) => m[i] ?? 0);

describe("hotbar slot order", () => {
  it("starts with the infinite starters in bar order", () => {
    expect(addPickedUp([], charges({ 0: INFINITE, 1: INFINITE, 6: INFINITE }), BAR)).toEqual([0, 1, 6]);
  });
  it("adds a finite spell when first held, in pickup order, not bar order", () => {
    let o = addPickedUp([], charges({ 0: INFINITE, 1: INFINITE, 6: INFINITE }), BAR);
    o = addPickedUp(o, charges({ 0: INFINITE, 1: INFINITE, 6: INFINITE, 5: 3 }), BAR);
    o = addPickedUp(o, charges({ 0: INFINITE, 1: INFINITE, 6: INFINITE, 5: 3, 2: 5 }), BAR);
    expect(o).toEqual([0, 1, 6, 5, 2]);
  });
  it("a spent spell keeps its slot, and re-pickup does not duplicate it", () => {
    let o = [0, 1, 6, 5];
    o = addPickedUp(o, charges({ 0: INFINITE, 1: INFINITE, 6: INFINITE, 5: 0 }), BAR);
    expect(o).toEqual([0, 1, 6, 5]);
    expect(addPickedUp(o, charges({ 5: 2 }), BAR)).toEqual([0, 1, 6, 5, ]);
  });
  it("returns the same array when nothing changed", () => {
    const o = [0, 1];
    expect(addPickedUp(o, charges({ 0: INFINITE, 1: INFINITE }), BAR)).toBe(o);
  });
  it("Creative (all infinite) shows every spell in bar order", () => {
    expect(addPickedUp([], charges(Object.fromEntries(BAR.map((s) => [s, INFINITE]))), BAR)).toEqual(BAR);
  });
  it("sandbox/no spells view gives no slots", () => {
    expect(addPickedUp([], charges({}), BAR)).toEqual([]);
  });
  it("swaps two slots without mutating, ignores bad indexes", () => {
    const o = [0, 1, 6, 5];
    expect(swapSlots(o, 0, 3)).toEqual([5, 1, 6, 0]);
    expect(o).toEqual([0, 1, 6, 5]);
    expect(swapSlots(o, 1, 1)).toBe(o);
    expect(swapSlots(o, 1, 9)).toBe(o);
  });
});
