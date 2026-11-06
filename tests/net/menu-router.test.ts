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

import { deathLine, relTime } from "../../client/menu/live.ts";

describe("menu live helpers", () => {
  it("relTime", () => {
    expect(relTime(-5000)).toBe("0s");
    expect(relTime(0)).toBe("0s");
    expect(relTime(12_400)).toBe("12s");
    expect(relTime(59_999)).toBe("59s");
    expect(relTime(60_000)).toBe("1m");
    expect(relTime(4 * 60_000 + 5000)).toBe("4m");
    expect(relTime(3 * 3600_000)).toBe("3h");
    expect(relTime(2 * 86400_000)).toBe("2d");
  });
  it("deathLine uses the in-game wording and plain names", () => {
    const base = { bag: false, mode: "survival", at: 0 };
    expect(deathLine({ ...base, victim: "Ana", killer: null, self: false, cause: 47 })).toBe("Ana was buried by the Sand Colossus");
    expect(deathLine({ ...base, victim: "Ana", killer: "Bo", self: false, cause: 1 })).toBe("Bo blasted Ana (Blast)");
    expect(deathLine({ ...base, victim: "Ana", killer: "Ana", self: true, cause: 5 })).toBe("Ana blew themselves up");
    expect(deathLine({ ...base, victim: "Ana", killer: null, self: false, cause: 14, bag: true })).toContain("and dropped their bag");
  });
});
