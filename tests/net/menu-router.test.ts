import { describe, expect, it } from "vitest";
import { formatRoute, parentRoute, parseRoute, type Route } from "../../client/menu/router.ts";

describe("menu router", () => {
  const cases: [string, Route][] = [
    ["", { kind: "title" }],
    ["#", { kind: "title" }],
    ["#new", { kind: "types" }],
    ["#new/survival", { kind: "settings", type: "survival" }],
    ["#new/deathmatch", { kind: "settings", type: "deathmatch" }],
    ["#join", { kind: "join" }],
    ["#share/ABC123", { kind: "share", code: "ABC123" }],
    ["#share/abc123", { kind: "share", code: "ABC123" }],
  ];
  for (const [h, r] of cases) it(`parses ${JSON.stringify(h)}`, () => expect(parseRoute(h)).toEqual(r));

  it("unknown hashes and bad codes map to the title", () => {
    for (const h of ["#nope", "#new/sandbox", "#new/", "#share", "#share/", "#share/ABCDEFG", "#share/AB-12", "#join/x", "#new/survival/x"]) {
      expect(parseRoute(h), h).toEqual({ kind: "title" });
    }
  });

  it("formatRoute round-trips every route", () => {
    for (const [, r] of cases) expect(parseRoute(formatRoute(r))).toEqual(r);
    expect(formatRoute({ kind: "settings", type: "survival" })).toBe("#new/survival");
    expect(formatRoute({ kind: "title" })).toBe("");
  });

  it("parentRoute walks one step up the tree", () => {
    expect(parentRoute({ kind: "settings", type: "deathmatch" })).toEqual({ kind: "types" });
    expect(parentRoute({ kind: "types" })).toEqual({ kind: "title" });
    expect(parentRoute({ kind: "join" })).toEqual({ kind: "title" });
    expect(parentRoute({ kind: "share", code: "ABC123" })).toEqual({ kind: "title" });
  });
});
