import { describe, expect, it } from "vitest";
import { applyBudget, consequences, padRepairCost } from "./agency-rules.ts";

const out = (kind: any, reasons: string[] = []) => ({ kind, reasons });
const go = (showing: any) => ({ role: "ground", report: "go" as const, showing });
const nogo = (showing: any) => ({ role: "ground", report: "nogo" as const, showing });

describe("agency rules", () => {
  it("success pays and wears equipment", () => {
    const c = consequences(out("success"), []);
    expect([c.budget, c.reputation, c.rocket.conditionDelta, c.rocket.flight, c.pad.conditionDelta]).toEqual([300, 5, -10, true, -5]);
  });
  it("explosion loses the rocket and wrecks the pad", () => {
    const c = consequences(out("explosion"), []);
    expect([c.budget, c.reputation, c.rocket.status, c.pad.conditionDelta]).toEqual([-400, -15, "lost", -60]);
  });
  it("pad abort sends the rocket to repair", () => {
    const c = consequences(out("pad_abort"), []);
    expect([c.budget, c.rocket.conditionDelta, c.rocket.status, c.pad.conditionDelta]).toEqual([-100, -40, "repair", -10]);
  });
  it("scrub costs 50, and lost contact costs reputation", () => {
    expect(consequences(out("scrub", ["Scrubbed by the Flight Director"]), []).reputation).toBe(0);
    const c = consequences(out("scrub", ["Crew lost contact"]), []);
    expect([c.budget, c.reputation]).toEqual([-50, -3]);
  });
  it("GO on a caution costs reputation even when the launch succeeds; speaking up earns it", () => {
    const c = consequences(out("success"), [go("caution"), go("nominal"), nogo("caution"), nogo("nominal")]);
    expect(c.reputation).toBe(5 - 3 + 2);
    expect(c.lines).toHaveLength(3);
    expect(c.lines.every((l) => l.reason.length > 0)).toBe(true);
  });
  it("budget clamps at zero and says so", () => {
    expect(applyBudget(100, -400)).toMatchObject({ budget: 0 });
    expect(applyBudget(100, -400).note).toContain("0");
    expect(applyBudget(500, -100)).toEqual({ budget: 400, note: "" });
  });
  it("pad repair is 10 per missing point", () => {
    expect(padRepairCost(100)).toBe(0);
    expect(padRepairCost(32)).toBe(680);
  });
});
