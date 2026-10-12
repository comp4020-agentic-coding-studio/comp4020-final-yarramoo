// Read-only crew records. Only DONE missions are ever counted: events carry
// fault truth. A poll report is attributed to whoever held that role's seat in
// that mission; every report counts, including re-poll rounds.
import { db } from "../db/index.ts";
import type { Role } from "../engine/types.ts";

export interface CrewProfileRow { id: number; callsign: string; created_at: number }

export function findCrew(callsign: string): CrewProfileRow | undefined {
  return db.prepare("SELECT id, callsign, created_at FROM crew WHERE callsign = ?").get(callsign) as unknown as CrewProfileRow | undefined;
}

export interface RecordTotals { reports: number; cautions: number; goOnCaution: number; spokeUp: number }
const ZERO: RecordTotals = { reports: 0, cautions: 0, goOnCaution: 0, spokeUp: 0 };

// One row per (crew, mission) of report counts, shared by the profile and the index.
const REPORTS_SQL = `
  SELECT s.crew_id AS crew_id, e.mission_id AS mission_id, COUNT(*) AS reports,
    SUM(json_extract(e.data_json, '$.showing') = 'caution') AS cautions,
    SUM(json_extract(e.data_json, '$.showing') = 'caution' AND json_extract(e.data_json, '$.report') = 'go') AS go_caution,
    SUM(json_extract(e.data_json, '$.showing') = 'caution' AND json_extract(e.data_json, '$.report') = 'nogo') AS spoke
  FROM mission_events e
  JOIN missions m ON m.id = e.mission_id AND m.status = 'done'
  JOIN seats s ON s.mission_id = e.mission_id AND s.role = e.role
  WHERE e.kind = 'poll_report'`;

interface ReportRow { crew_id: number; mission_id: number; reports: number; cautions: number; go_caution: number; spoke: number }

export interface FlownMission {
  id: number; code: string; sequence_id: string; outcome: string | null; ended: number; roles: Role[]; goOnCaution: number;
}

export interface Profile {
  flown: number;
  outcomes: Record<string, number>;
  roles: { role: Role; n: number }[];
  record: RecordTotals;
  missions: FlownMission[];
}

export function profileOf(crewId: number): Profile {
  const rows = db.prepare(
    `SELECT m.id, m.code, m.sequence_id, json_extract(m.outcome_json, '$.kind') AS outcome,
            COALESCE(m.ended_at, m.created_at) AS ended, GROUP_CONCAT(s.role) AS roles
     FROM seats s JOIN missions m ON m.id = s.mission_id AND m.status = 'done'
     WHERE s.crew_id = ? GROUP BY m.id ORDER BY ended DESC, m.id DESC`,
  ).all(crewId) as unknown as { id: number; code: string; sequence_id: string; outcome: string | null; ended: number; roles: string }[];
  const perMission = new Map<number, ReportRow>();
  const record = { ...ZERO };
  for (const r of db.prepare(`${REPORTS_SQL} AND s.crew_id = ? GROUP BY s.crew_id, e.mission_id`).all(crewId) as unknown as ReportRow[]) {
    perMission.set(r.mission_id, r);
    record.reports += r.reports; record.cautions += r.cautions; record.goOnCaution += r.go_caution; record.spokeUp += r.spoke;
  }
  const outcomes: Record<string, number> = {};
  const roleCount = new Map<Role, number>();
  for (const r of rows) {
    outcomes[r.outcome ?? "ended"] = (outcomes[r.outcome ?? "ended"] ?? 0) + 1;
    for (const role of r.roles.split(",") as Role[]) roleCount.set(role, (roleCount.get(role) ?? 0) + 1);
  }
  return {
    flown: rows.length,
    outcomes,
    roles: [...roleCount].map(([role, n]) => ({ role, n })).sort((a, b) => b.n - a.n || a.role.localeCompare(b.role)),
    record,
    missions: rows.slice(0, 30).map((r) => ({
      id: r.id, code: r.code, sequence_id: r.sequence_id, outcome: r.outcome, ended: r.ended,
      roles: r.roles.split(",") as Role[], goOnCaution: perMission.get(r.id)?.go_caution ?? 0,
    })),
  };
}

export type CrewSort = "flown" | "spoke" | "caution";
export const isCrewSort = (v: unknown): v is CrewSort => v === "flown" || v === "spoke" || v === "caution";

export interface CrewIndexRow extends RecordTotals { callsign: string; flown: number }

export function crewIndex(sort: CrewSort): CrewIndexRow[] {
  const flown = db.prepare(
    `SELECT c.id, c.callsign, COUNT(DISTINCT s.mission_id) AS flown
     FROM seats s JOIN missions m ON m.id = s.mission_id AND m.status = 'done' JOIN crew c ON c.id = s.crew_id GROUP BY c.id`,
  ).all() as unknown as { id: number; callsign: string; flown: number }[];
  const totals = new Map<number, RecordTotals>();
  for (const r of db.prepare(`${REPORTS_SQL} GROUP BY s.crew_id, e.mission_id`).all() as unknown as ReportRow[]) {
    const t = totals.get(r.crew_id) ?? { ...ZERO };
    t.reports += r.reports; t.cautions += r.cautions; t.goOnCaution += r.go_caution; t.spokeUp += r.spoke;
    totals.set(r.crew_id, t);
  }
  const rows = flown.map((f) => ({ callsign: f.callsign, flown: f.flown, ...(totals.get(f.id) ?? ZERO) }));
  const key = (r: CrewIndexRow): number => (sort === "spoke" ? r.spokeUp : sort === "caution" ? r.goOnCaution : r.flown);
  rows.sort((a, b) => key(b) - key(a) || b.flown - a.flown || a.callsign.localeCompare(b.callsign, "en", { sensitivity: "base" }));
  return rows.slice(0, 100);
}
