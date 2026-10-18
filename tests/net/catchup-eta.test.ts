import { describe, expect, it } from "vitest";
import { etaText, replayRate } from "../../client/catchup.ts";

describe("replayRate", () => {
  it("is unknown with fewer than two samples or no progress", () => {
    expect(replayRate([])).toBeNull();
    expect(replayRate([{ ms: 0, tick: 0 }])).toBeNull();
    expect(replayRate([{ ms: 0, tick: 5 }, { ms: 500, tick: 5 }])).toBeNull();
  });
  it("averages over the window only", () => {
    const s = [{ ms: 0, tick: 0 }, { ms: 10_000, tick: 10_000 }, { ms: 12_000, tick: 10_200 }, { ms: 14_000, tick: 10_400 }];
    expect(replayRate(s)).toBeCloseTo(100, 5); // the fast first 10 s is outside the 5 s window
  });
});

describe("etaText", () => {
  it("handles an unknown rate and nothing left", () => {
    expect(etaText(1000, null)).toBe("estimating…");
    expect(etaText(1000, 0)).toBe("estimating…");
    expect(etaText(0, 100)).toBe("almost there");
  });
  it("says a few seconds under five", () => expect(etaText(300, 100)).toBe("a few seconds"));
  it("rounds seconds to five", () => expect(etaText(2300, 100)).toBe("about 25 seconds"));
  it("says about a minute between 50 and 90 seconds", () => {
    expect(etaText(6000, 100)).toBe("about a minute");
    expect(etaText(8900, 100)).toBe("about a minute");
  });
  it("counts minutes beyond that", () => expect(etaText(30_000, 100)).toBe("about 5 minutes"));
  it("gives up on hours", () => expect(etaText(1_000_000, 100)).toBe("over an hour"));
});
