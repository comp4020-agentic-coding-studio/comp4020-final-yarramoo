import { publish } from "../bus.ts";
import { db, tx } from "../db/index.ts";
import type { State } from "../engine/types.ts";
import { applyBudget, clamp, consequences, COSTS, padRepairCost, PAD_MIN_CONDITION, type PollReportLite } from "./agency-rules.ts";

// The one shared agency. Every write that spends or earns is a single
// transaction with a conditional UPDATE, so simultaneous requests cannot
// overspend or repair twice.

export const AGENCY_TOPIC = "agency";
export const publishAgency = (): void => publish(AGENCY_TOPIC, { type: "agency" });

export interface Pad { id: number; name: string; condition: number }
export interface Rocket { id: number; name: string; condition: number; status: "ready" | "repair" | "lost"; flights: number }
export interface LedgerRow { id: number; at: number; mission_id: number | null; code: string | null; callsign: string | null; budget_delta: number; reputation_delta: number; reason: string }

export const getAgency = (): { budget: number; reputation: number } =>
  db.prepare("SELECT budget, reputation FROM agency WHERE id = 1").get() as unknown as { budget: number; reputation: number };
export const getPads = (): Pad[] => db.prepare("SELECT * FROM pads ORDER BY id").all() as unknown as Pad[];
export const getRockets = (): Rocket[] => db.prepare("SELECT * FROM rockets ORDER BY id").all() as unknown as Rocket[];
const rocketById = (id: number | null): Rocket | undefined =>
  id == null ? undefined : (db.prepare("SELECT * FROM rockets WHERE id = ?").get(id) as unknown as Rocket | undefined);
const padById = (id: number | null): Pad | undefined =>
  id == null ? undefined : (db.prepare("SELECT * FROM pads WHERE id = ?").get(id) as unknown as Pad | undefined);

export function agencySummary(): { budget: number; reputation: number; pad: Pad | undefined; ready: number } {
  const a = getAgency();
  const ready = Number((db.prepare("SELECT COUNT(*) AS n FROM rockets WHERE status = 'ready'").get() as unknown as { n: number }).n);
  return { ...a, pad: getPads()[0], ready };
}

const LEDGER_SQL = `SELECT l.id, l.at, l.mission_id, m.code, c.callsign, l.budget_delta, l.reputation_delta, l.reason
  FROM agency_ledger l LEFT JOIN missions m ON m.id = l.mission_id LEFT JOIN crew c ON c.id = l.crew_id`;
export const latestLedger = (limit: number): LedgerRow[] =>
  db.prepare(`${LEDGER_SQL} ORDER BY l.id DESC LIMIT ?`).all(limit) as unknown as LedgerRow[];
export const ledgerForMission = (missionId: number): LedgerRow[] =>
  db.prepare(`${LEDGER_SQL} WHERE l.mission_id = ? ORDER BY l.id`).all(missionId) as unknown as LedgerRow[];

const addLedger = (at: number, missionId: number | null, crewId: number | null, budget: number, rep: number, reason: string): void => {
  db.prepare("INSERT INTO agency_ledger (at, mission_id, crew_id, budget_delta, reputation_delta, reason) VALUES (?, ?, ?, ?, ?, ?)").run(at, missionId, crewId, budget, rep, reason);
};

// ------------------------------------------------------------- assignment

/** Ready rockets, preferring ones no unfinished mission already holds. Lowest id first. */
function pickRocket(excludeMission: number | null): Rocket | undefined {
  const ready = db.prepare("SELECT * FROM rockets WHERE status = 'ready' ORDER BY id").all() as unknown as Rocket[];
  const held = new Set(
    (db.prepare("SELECT rocket_id FROM missions WHERE status != 'done' AND rocket_id IS NOT NULL AND id != ?").all(excludeMission ?? -1) as unknown as { rocket_id: number }[]).map((r) => r.rocket_id),
  );
  return ready.find((r) => !held.has(r.id)) ?? ready[0];
}

/**
 * Prefer a rocket no live mission is flying. When every ready rocket is
 * flying, missions share one rather than queue: a small fleet must not cap
 * how many crews can play at once (applyOutcome copes with a shared rocket).
 */
const flyingElsewhere = (rocketId: number, missionId: number): boolean =>
  db.prepare("SELECT 1 FROM missions WHERE status = 'live' AND rocket_id = ? AND id != ?").get(rocketId, missionId) !== undefined;

/** At mission creation: the first free ready rocket and the first pad. May be null (the lobby says why). */
export function assignment(): { rocketId: number | null; padId: number | null } {
  return { rocketId: pickRocket(null)?.id ?? null, padId: getPads()[0]?.id ?? null };
}

export interface StartPreview { rocket: Rocket | undefined; pad: Pad | undefined; blocked: string | null }

/** Why a lobby mission cannot start on the agency's side, or null. Read only. */
export function previewStart(m: { id: number; rocket_id: number | null; pad_id: number | null }): StartPreview {
  const pad = padById(m.pad_id);
  let rocket = rocketById(m.rocket_id);
  if (!rocket || rocket.status !== "ready" || flyingElsewhere(rocket.id, m.id)) rocket = pickRocket(m.id) ?? rocket;
  let blocked: string | null = null;
  if (!rocket || rocket.status !== "ready") blocked = "No rocket is ready. Repair or buy one on the Agency page.";
  else if (pad && pad.condition < PAD_MIN_CONDITION) blocked = `Pad ${pad.name} is at ${pad.condition}%. Repair it on the Agency page.`;
  return { rocket, pad, blocked };
}

/** At start: re-check, reassign a rocket if ours was flown or lost meanwhile. Returns an error or null. */
export function claimForStart(m: { id: number; rocket_id: number | null; pad_id: number | null }): string | null {
  const p = previewStart(m);
  if (p.blocked) return p.blocked;
  if (p.rocket && p.rocket.id !== m.rocket_id) db.prepare("UPDATE missions SET rocket_id = ? WHERE id = ?").run(p.rocket.id, m.id);
  return null;
}

// ------------------------------------------------------- mission outcome

/**
 * Called from rooms.ts commit() INSIDE the transaction that marks the mission
 * done, so the outcome and its consequences land together or not at all.
 * Reads the final state's poll reports (never events).
 */
export function applyOutcome(missionId: number, state: State, now: number): void {
  if (!state.outcome) return;
  const reports: PollReportLite[] = [];
  for (const p of Object.values(state.polls)) {
    // the current round plus earlier rounds: every report said counts
    for (const round of [...p.history, p.reports]) {
      for (const [role, r] of Object.entries(round)) if (r) reports.push({ role, report: r.report, showing: r.showing });
    }
  }
  const c = consequences(state.outcome, reports);
  const row = db.prepare("SELECT rocket_id, pad_id FROM missions WHERE id = ?").get(missionId) as unknown as { rocket_id: number | null; pad_id: number | null };
  const before = getAgency();
  const { budget, note } = applyBudget(before.budget, c.budget);
  const rep = clamp(before.reputation + c.reputation, 0, 100);
  db.prepare("UPDATE agency SET budget = ?, reputation = ? WHERE id = 1").run(budget, rep);
  c.lines.forEach((l, i) => addLedger(now, missionId, null, l.budget, l.reputation, i === 0 ? l.reason + note : l.reason));

  const rocket = rocketById(row.rocket_id);
  // A shared rocket may already have been lost on another mission; it stays lost.
  if (rocket && rocket.status === "lost") {
    addLedger(now, missionId, null, 0, 0, `Rocket ${rocket.name} was already lost on another mission; no further damage recorded`);
  } else if (rocket) {
    const cond = clamp(rocket.condition + c.rocket.conditionDelta, 0, 100);
    db.prepare("UPDATE rockets SET condition = ?, status = ?, flights = flights + ? WHERE id = ?").run(cond, c.rocket.status ?? rocket.status, c.rocket.flight ? 1 : 0, rocket.id);
    if (c.rocket.status) addLedger(now, missionId, null, 0, 0, `Rocket ${rocket.name} ${c.rocket.status === "lost" ? "lost" : "needs repair"}`);
  }
  const pad = padById(row.pad_id);
  if (pad && c.pad.conditionDelta !== 0) {
    const cond = clamp(pad.condition + c.pad.conditionDelta, 0, 100);
    db.prepare("UPDATE pads SET condition = ? WHERE id = ?").run(cond, pad.id);
    addLedger(now, missionId, null, 0, 0, `Pad ${pad.name} damaged: ${pad.condition}% to ${cond}%`);
  }
}

// ------------------------------------------------------ repairs / purchases

export type SpendResult = { ok: true; message: string } | { ok: false; error: string };
class Refused extends Error {}

/** Deduct from the budget only if it covers it; the conditional UPDATE is the whole check. */
function spend(cost: number): void {
  const r = db.prepare("UPDATE agency SET budget = budget - ? WHERE id = 1 AND budget >= ?").run(cost, cost);
  if (Number(r.changes) === 0) throw new Refused(`The agency cannot afford that: it costs ${cost} credits and the budget is ${getAgency().budget}.`);
}

function transact(fn: () => string): SpendResult {
  try {
    const message = tx(fn);
    publishAgency();
    return { ok: true, message };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

export function repairPad(crewId: number): SpendResult {
  return transact(() => {
    const pad = getPads()[0];
    if (!pad) throw new Refused("There is no pad.");
    const cost = padRepairCost(pad.condition);
    if (cost === 0) throw new Refused(`Nothing to repair: ${pad.name} is at 100%.`);
    const r = db.prepare("UPDATE pads SET condition = 100 WHERE id = ? AND condition = ?").run(pad.id, pad.condition);
    if (Number(r.changes) === 0) throw new Refused("The pad changed while you were repairing it; try again.");
    spend(cost);
    addLedger(Date.now(), null, crewId, -cost, 0, `Repaired pad ${pad.name} from ${pad.condition}%`);
    return `Pad ${pad.name} repaired for ${cost} credits.`;
  });
}

export function repairRocket(crewId: number, rocketId: number): SpendResult {
  return transact(() => {
    const rk = rocketById(rocketId);
    if (!rk) throw new Refused("No such rocket.");
    const r = db.prepare("UPDATE rockets SET status = 'ready', condition = 100 WHERE id = ? AND status = 'repair'").run(rocketId);
    if (Number(r.changes) === 0) throw new Refused(`${rk.name} does not need repair.`);
    spend(COSTS.rocketRepair);
    addLedger(Date.now(), null, crewId, -COSTS.rocketRepair, 0, `Repaired rocket ${rk.name}`);
    return `${rk.name} repaired for ${COSTS.rocketRepair} credits.`;
  });
}

export function buyRocket(crewId: number): SpendResult {
  return transact(() => {
    spend(COSTS.rocketBuy);
    const n = Number((db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM rockets").get() as unknown as { n: number }).n);
    const name = `K1-${String(n).padStart(2, "0")}`;
    db.prepare("INSERT INTO rockets (name, condition, status) VALUES (?, 100, 'ready')").run(name);
    addLedger(Date.now(), null, crewId, -COSTS.rocketBuy, 0, `Bought rocket ${name}`);
    return `${name} bought for ${COSTS.rocketBuy} credits.`;
  });
}

// ------------------------------------------------------- emergency appropriation

/**
 * What it would cost to fly again, or 0 if the agency can already fly. The
 * agency is grounded when the pad is under PAD_MIN_CONDITION or no rocket is
 * ready; a rocket under repair is cheaper to fix than a new one.
 */
export function costToFly(): number {
  const pad = getPads()[0];
  const rockets = getRockets();
  let cost = pad && pad.condition < PAD_MIN_CONDITION ? padRepairCost(pad.condition) : 0;
  if (!rockets.some((r) => r.status === "ready")) {
    cost += rockets.some((r) => r.status === "repair") ? COSTS.rocketRepair : COSTS.rocketBuy;
  }
  return cost;
}

/** Grounded and broke: the shortfall, else 0. Without this a shared agency could die for good. */
export function appropriationNeeded(): number {
  return Math.max(0, costToFly() - getAgency().budget);
}

export const APPROPRIATION_REPUTATION = -10;

export function emergencyAppropriation(crewId: number): SpendResult {
  return transact(() => {
    const grant = appropriationNeeded();
    if (grant === 0) throw new Refused("The agency can still fly on its own budget, so there is nothing to appropriate.");
    db.prepare("UPDATE agency SET budget = budget + ?, reputation = MAX(0, reputation + ?) WHERE id = 1").run(grant, APPROPRIATION_REPUTATION);
    addLedger(Date.now(), null, crewId, grant, APPROPRIATION_REPUTATION, "Emergency appropriation: the agency was grounded and could not pay to fly");
    return `Granted ${grant} credits, enough to fly again. Reputation ${APPROPRIATION_REPUTATION}.`;
  });
}
