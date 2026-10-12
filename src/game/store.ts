import { randomInt } from "node:crypto";
import { db, tx } from "../db/index.ts";
import { init } from "../engine/engine.ts";
import { ROLES, type Role } from "../engine/types.ts";
import { assignment } from "./agency.ts";
import { DEFAULT_SEQUENCE, getSequence } from "./sequences.ts";

export interface MissionRow {
  id: number;
  code: string;
  sequence_id: string;
  seed: number;
  status: "lobby" | "live" | "done";
  state_json: string;
  clock_offset_ms: number;
  last_seen_ms: number;
  outcome_json: string | null;
  created_by: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  rocket_id: number | null;
  pad_id: number | null;
}

/** Callsign per role; roles nobody holds are absent. */
export type Seats = Partial<Record<Role, string>>;

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

export function getMission(code: string): MissionRow | undefined {
  if (!CODE_RE.test(code)) return undefined;
  return db.prepare("SELECT * FROM missions WHERE code = ?").get(code) as unknown as MissionRow | undefined;
}

export function createMission(crewId: number, sequenceId: string = DEFAULT_SEQUENCE): MissionRow {
  const seq = getSequence(sequenceId); // throws on an unknown id; the route checks the allowlist first
  const seed = randomInt(0, 2 ** 32);
  const state = JSON.stringify(init(seq, seed));
  const { rocketId, padId } = assignment();
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    try {
      db.prepare(
        "INSERT INTO missions (code, sequence_id, seed, status, state_json, created_by, created_at, rocket_id, pad_id) VALUES (?, ?, ?, 'lobby', ?, ?, ?, ?, ?)",
      ).run(code, seq.id, seed, state, crewId, Date.now(), rocketId, padId);
      return getMission(code)!;
    } catch (e) {
      if (!String((e as Error).message).includes("UNIQUE")) throw e;
    }
  }
  throw new Error("could not allocate a mission code");
}

export function seatsOf(missionId: number): Seats {
  const rows = db
    .prepare("SELECT s.role, c.callsign FROM seats s JOIN crew c ON c.id = s.crew_id WHERE s.mission_id = ?")
    .all(missionId) as unknown as { role: Role; callsign: string }[];
  const out: Seats = {};
  for (const r of rows) out[r.role] = r.callsign;
  return out;
}

export function rolesHeld(missionId: number, crewId: number): Role[] {
  const rows = db
    .prepare("SELECT role FROM seats WHERE mission_id = ? AND crew_id = ?")
    .all(missionId, crewId) as unknown as { role: Role }[];
  const held = new Set(rows.map((r) => r.role));
  return ROLES.filter((r) => held.has(r));
}

export function holds(missionId: number, crewId: number, role: Role): boolean {
  return db.prepare("SELECT 1 FROM seats WHERE mission_id = ? AND role = ? AND crew_id = ?").get(missionId, role, crewId) !== undefined;
}

/** Returns an error message, or null on success. Lobby only; the primary key makes a claim atomic. */
export function claimSeat(m: MissionRow, crewId: number, role: Role): string | null {
  if (m.status !== "lobby") return "Seats can only change while the mission is in the lobby.";
  if (!getSequence(m.sequence_id).roles.includes(role)) return "That role is not part of this mission.";
  try {
    db.prepare("INSERT INTO seats (mission_id, role, crew_id) VALUES (?, ?, ?)").run(m.id, role, crewId);
    return null;
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) return "Someone already holds that seat.";
    throw e;
  }
}

export function releaseSeat(m: MissionRow, crewId: number, role: Role): string | null {
  if (m.status !== "lobby") return "Seats can only change while the mission is in the lobby.";
  const r = db.prepare("DELETE FROM seats WHERE mission_id = ? AND role = ? AND crew_id = ?").run(m.id, role, crewId);
  return r.changes === 0 ? "You do not hold that seat." : null;
}

/** Unstarted lobbies older than a day are deleted (seats cascade). */
export function deleteStaleLobbies(now: number): number {
  const r = db.prepare("DELETE FROM missions WHERE status = 'lobby' AND created_at < ?").run(now - 24 * 3600_000);
  return Number(r.changes);
}

/** Missions this crew member made or sits in, newest first, not finished. */
export function openMissionsFor(crewId: number): { code: string; status: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT m.code, m.status, m.created_at FROM missions m
       LEFT JOIN seats s ON s.mission_id = m.id
       WHERE m.status != 'done' AND (m.created_by = ? OR s.crew_id = ?)
       ORDER BY m.created_at DESC LIMIT 10`,
    )
    .all(crewId, crewId) as unknown as { code: string; status: string }[];
}

export { tx };

// ---------------------------------------------------------------- history (read only)

export interface EventRow {
  seq: number;
  at_t: number;
  kind: string;
  role: Role | null;
  data: Record<string, unknown>;
}

/** Every event of a mission in order. Callers must only use this for done missions: events carry fault truth. */
export function eventsOf(missionId: number): EventRow[] {
  const rows = db
    .prepare("SELECT seq, at_t, kind, role, data_json FROM mission_events WHERE mission_id = ? ORDER BY seq")
    .all(missionId) as unknown as { seq: number; at_t: number; kind: string; role: Role | null; data_json: string | null }[];
  return rows.map((r) => ({ seq: r.seq, at_t: r.at_t, kind: r.kind, role: r.role, data: r.data_json ? JSON.parse(r.data_json) : {} }));
}

/** Seats of many missions at once. */
export function seatsOfMany(ids: number[]): Map<number, Seats> {
  const out = new Map<number, Seats>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(`SELECT s.mission_id, s.role, c.callsign FROM seats s JOIN crew c ON c.id = s.crew_id WHERE s.mission_id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as unknown as { mission_id: number; role: Role; callsign: string }[];
  for (const r of rows) {
    const s = out.get(r.mission_id) ?? {};
    s[r.role] = r.callsign;
    out.set(r.mission_id, s);
  }
  return out;
}

export function liveMissions(): MissionRow[] {
  return db.prepare("SELECT * FROM missions WHERE status = 'live' ORDER BY started_at DESC").all() as unknown as MissionRow[];
}

export function doneMissions(limit: number, offset: number): MissionRow[] {
  return db
    .prepare("SELECT * FROM missions WHERE status = 'done' ORDER BY COALESCE(ended_at, created_at) DESC, id DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as MissionRow[];
}

export function countDone(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM missions WHERE status = 'done'").get() as unknown as { n: number }).n);
}

/** Per mission: poll reports where GO was said while that seat's console showed caution. */
export function goOnCautionCounts(ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(`SELECT mission_id, data_json FROM mission_events WHERE kind = 'poll_report' AND mission_id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as unknown as { mission_id: number; data_json: string | null }[];
  for (const r of rows) {
    const d = r.data_json ? JSON.parse(r.data_json) : {};
    if (d.report === "go" && d.showing === "caution") out.set(r.mission_id, (out.get(r.mission_id) ?? 0) + 1);
  }
  return out;
}
