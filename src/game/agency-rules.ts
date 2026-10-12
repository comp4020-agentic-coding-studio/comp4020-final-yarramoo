// Pure agency rules: what a finished mission costs or earns. No database here;
// agency.ts applies the result. Tune the numbers in RULES.

import type { Outcome } from "../engine/types.ts";

export interface PollReportLite {
  role: string;
  report: "go" | "nogo";
  showing: "nominal" | "caution";
}

export interface Line {
  budget: number;
  reputation: number;
  reason: string;
}

export interface Consequences {
  budget: number;
  reputation: number;
  rocket: { conditionDelta: number; status?: "repair" | "lost"; flight: boolean };
  pad: { conditionDelta: number };
  lines: Line[];
}

type Kind = Outcome["kind"];

/** The one table to tune. Rocket status "repair"/"lost" is set outright; deltas are signed. */
export const RULES: Record<Kind, { budget: number; reputation: number; rocket: number; rocketStatus?: "repair" | "lost"; flight: boolean; pad: number; label: string }> = {
  success: { budget: 300, reputation: 5, rocket: -10, flight: true, pad: -5, label: "Successful launch" },
  pad_abort: { budget: -100, reputation: -2, rocket: -40, rocketStatus: "repair", flight: false, pad: -10, label: "Pad abort" },
  explosion: { budget: -400, reputation: -15, rocket: 0, rocketStatus: "lost", flight: false, pad: -60, label: "Explosion" },
  scrub: { budget: -50, reputation: 0, rocket: 0, flight: false, pad: 0, label: "Scrub" },
  // terminated: the reputation here is the "healthy vehicle destroyed" case; a real anomaly earns TERMINATED_REAL_REPUTATION instead
  terminated: { budget: -300, reputation: -5, rocket: 0, rocketStatus: "lost", flight: false, pad: 0, label: "Healthy vehicle destroyed" },
  range_violation: { budget: -500, reputation: -25, rocket: 0, rocketStatus: "lost", flight: false, pad: -10, label: "Range violation" },
};
export const TERMINATED_REAL_REPUTATION = 3;
export const TERMINATED_REAL_REASON = "Range made the call";
export const LOST_CONTACT_REASON = "Crew lost contact";
export const LOST_CONTACT_REPUTATION = -3;
export const GO_ON_CAUTION = -3;
export const SPOKE_UP = 2;
export const PAD_MIN_CONDITION = 40;
export const COSTS = { padPerPoint: 10, rocketRepair: 200, rocketBuy: 500 };

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const sign = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** Facts about the finished mission that the outcome kind alone does not carry. */
export interface Truth {
  /** a real anomaly was active when the mission ended */
  anomalyReal?: boolean;
}

export function consequences(outcome: Pick<Outcome, "kind" | "reasons">, reports: PollReportLite[], truth: Truth = {}): Consequences {
  const r = RULES[outcome.kind];
  const lines: Line[] = [{ budget: r.budget, reputation: r.reputation, reason: r.label }];
  let reputation = r.reputation;
  if (outcome.kind === "terminated" && truth.anomalyReal) {
    lines[0] = { budget: r.budget, reputation: TERMINATED_REAL_REPUTATION, reason: TERMINATED_REAL_REASON };
    reputation = TERMINATED_REAL_REPUTATION;
  }
  if (outcome.kind === "scrub" && outcome.reasons.includes(LOST_CONTACT_REASON)) {
    lines[0] = { budget: r.budget, reputation: LOST_CONTACT_REPUTATION, reason: "Scrub: the crew lost contact" };
    reputation = LOST_CONTACT_REPUTATION;
  }
  for (const p of reports) {
    if (p.showing !== "caution") continue;
    if (p.report === "go") {
      lines.push({ budget: 0, reputation: GO_ON_CAUTION, reason: `GO on a caution (${p.role})` });
      reputation += GO_ON_CAUTION;
    } else {
      lines.push({ budget: 0, reputation: SPOKE_UP, reason: `Spoke up: NO-GO on a caution (${p.role})` });
      reputation += SPOKE_UP;
    }
  }
  return {
    budget: r.budget,
    reputation,
    rocket: { conditionDelta: r.rocket, ...(r.rocketStatus ? { status: r.rocketStatus } : {}), flight: r.flight },
    pad: { conditionDelta: r.pad },
    lines,
  };
}

/** Budget after an outcome delta, never below 0; says so when it clamped. */
export function applyBudget(budget: number, delta: number): { budget: number; note: string } {
  const next = budget + delta;
  if (next >= 0) return { budget: next, note: "" };
  return { budget: 0, note: ` (budget bottomed out at 0; ${sign(-next)} unrecovered)` };
}

/** Cost to restore a pad: 10 credits per missing percentage point. */
export const padRepairCost = (condition: number): number => (100 - clamp(condition, 0, 100)) * COSTS.padPerPoint;
