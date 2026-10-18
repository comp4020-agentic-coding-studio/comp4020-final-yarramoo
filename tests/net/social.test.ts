// Pure helpers behind the who's-online list, the minimap and the name-tag fade.
import { describe, expect, it } from "vitest";
import { fadeAlpha, nearestPlayer, sortPlayers, stripToCamera, viewBracket, worldToStrip } from "../../client/social.ts";

const p = (id: number, name: string, me = false, dead = false) => ({ id, name, me, dead });

describe("sortPlayers", () => {
  it("puts you first, the living next, the dead last, then by name", () => {
    const out = sortPlayers([p(1, "zed"), p(2, "Bo", false, true), p(3, "amy"), p(4, "Me", true), p(5, "Cy")]);
    expect(out.map((x) => x.id)).toEqual([4, 3, 5, 1, 2]);
  });
  it("breaks name ties by id and does not mutate its input", () => {
    const input = [p(9, "Al"), p(2, "al")];
    expect(sortPlayers(input).map((x) => x.id)).toEqual([2, 9]);
    expect(input[0].id).toBe(9);
  });
});

describe("minimap mapping", () => {
  it("maps world to strip and clamps", () => {
    expect(worldToStrip(1024, 2048, 400)).toBe(200);
    expect(worldToStrip(-5, 2048, 400)).toBe(0);
    expect(worldToStrip(5000, 2048, 400)).toBe(400);
  });
  it("the bracket is the view's share of the width, kept inside the strip", () => {
    expect(viewBracket(0, 512, 2048, 400)).toEqual({ left: 0, width: 100 });
    expect(viewBracket(2048, 512, 2048, 400).left).toBe(300);
    expect(viewBracket(0, 1, 2048, 400).width).toBe(6);
  });
  it("a click centres the camera and clamps to the world", () => {
    expect(stripToCamera(200, 400, 2048, 480)).toBe(1024 - 240);
    expect(stripToCamera(0, 400, 2048, 480)).toBe(0);
    expect(stripToCamera(400, 400, 2048, 480)).toBe(2048 - 480);
  });
});

describe("fadeAlpha", () => {
  it("is full near, the floor far, linear between", () => {
    expect(fadeAlpha(10, 100, 300)).toBe(1);
    expect(fadeAlpha(100, 100, 300)).toBe(1);
    expect(fadeAlpha(400, 100, 300, 0.2)).toBe(0.2);
    expect(fadeAlpha(200, 100, 300, 0.2)).toBeCloseTo(0.6);
  });
});

describe("nearestPlayer", () => {
  const ps = [
    { id: 1, x: 100, y: 50 },
    { id: 2, x: 1000, y: 50 },
    { id: 3, x: 1010, y: 1800 },
  ];
  it("picks the player nearest on the strip, by horizontal and vertical distance", () => {
    // strip 400 x 200 over a 2048 x 2048 world: 5.12 cells per px across, 10.24 down
    expect(nearestPlayer(ps, 10, 5, 2048, 2048, 400, 200)?.id).toBe(1);
    expect(nearestPlayer(ps, 195, 3, 2048, 2048, 400, 200)?.id).toBe(2);
    expect(nearestPlayer(ps, 197, 190, 2048, 2048, 400, 200)?.id).toBe(3);
  });
  it("is null with nobody there, and ties go to the lower id", () => {
    expect(nearestPlayer([], 5, 5, 2048, 2048, 400, 200)).toBeNull();
    const t = [{ id: 9, x: 0, y: 0 }, { id: 4, x: 0, y: 0 }];
    expect(nearestPlayer(t, 0, 0, 2048, 2048, 400, 200)?.id).toBe(4);
  });
});
