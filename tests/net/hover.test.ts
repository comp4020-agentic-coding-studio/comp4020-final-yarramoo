// The hover lookup's priority: enemy over player over pickup/bag/heal over material; Empty names nothing.
import { describe, expect, it } from "vitest";
import { ENT_BAG, ENT_ENEMY, ENT_HEAL, ENT_PICKUP, ENT_PLAYER, type EntityView } from "../../shared/sim.ts";
import { lookupHover } from "../../client/hover.ts";

const W = 64;
const H = 64;
const mat = new Uint8Array(W * H);
const ent = (type: number, x: number, y: number, o: Partial<EntityView> = {}): EntityView => ({ type, id: 1, active: true, sub: 0, x: x * 16, y: y * 16, a: 0, health: 100, ...o });
const nameOf = (id: number) => (id === 7 ? "Ana" : undefined);

describe("lookupHover", () => {
  it("nothing for empty air", () => expect(lookupHover(10, 10, [], mat, W, H, nameOf)).toBeNull());
  it("names the material, not Empty", () => {
    mat[20 * W + 10] = 5;
    mat[21 * W + 10] = 14;
    expect(lookupHover(10.5, 20.5, [], mat, W, H, nameOf)).toBe("Water");
    expect(lookupHover(10.5, 21.5, [], mat, W, H, nameOf)).toBe("Lava");
  });
  it("outside the world is nothing", () => expect(lookupHover(-3, 5, [], mat, W, H, nameOf)).toBeNull());
  it("a pickup beats the material under it", () => {
    const e = [ent(ENT_PICKUP, 10, 21, { sub: 4, a: 10 })];
    expect(lookupHover(10.5, 20.5, e, mat, W, H, nameOf)).toBe("Fire x10");
  });
  it("a bag and a heal", () => {
    expect(lookupHover(30, 30, [ent(ENT_BAG, 30, 30, { a: 7 })], mat, W, H, nameOf)).toBe("Bag, 7 charges");
    expect(lookupHover(30, 30, [ent(ENT_HEAL, 30, 30, { a: 25 })], mat, W, H, nameOf)).toBe("Heal +25");
  });
  it("a player beats a pickup and a material", () => {
    const e = [ent(ENT_PICKUP, 10, 21, { sub: 4, a: 10 }), ent(ENT_PLAYER, 10, 22, { id: 7 })];
    expect(lookupHover(10.5, 20.5, e, mat, W, H, nameOf)).toBe("Ana");
  });
  it("a dead player is not named", () => {
    expect(lookupHover(10.5, 20.5, [ent(ENT_PLAYER, 10, 22, { id: 7, health: 0 })], mat, W, H, nameOf)).toBe("Water");
  });
  it("an enemy beats everything, with hp", () => {
    const e = [ent(ENT_PLAYER, 10, 22, { id: 7 }), ent(ENT_PICKUP, 10, 21, { sub: 4 }), ent(ENT_ENEMY, 10, 22, { sub: 1, a: 12 })];
    expect(lookupHover(10.5, 20.5, e, mat, W, H, nameOf)).toBe("Fire imp 12/30");
  });
});
