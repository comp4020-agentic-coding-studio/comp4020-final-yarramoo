// R2a (plan "Server: rooms instead of two fixed worlds"): the rooms table's data-access and validation layer.
// Inert next to the two fixed worlds (server/world.ts) — nothing here is reachable from the socket path yet.
// A room's id is its eventual world id (plan: "the existing world tables are already keyed by world id").
import { randomBytes } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { cleanName } from "../shared/protocol.ts";
import { decodeConfig, CONFIG_BYTES, type RoomConfig } from "../shared/room.ts";
import type { GameDb } from "./db.ts";

export const MAX_ROOM_NAME_CHARS = 32;
export const ROOM_CODE_LEN = 6;
/** Plan: "3 rooms created per visitor per day". An anonymous creator (no player id) is not tracked here —
 * see the "Architectural decisions for review" note in docs/research/r2a-worker-report.md: R2b, once joining
 * is real, is where an anonymous creator even makes sense to rate-limit, and by IP rather than player id. */
export const MAX_ROOMS_PER_CREATOR_PER_DAY = 3;
export const DAY_MS = 24 * 60 * 60_000;

export const ROOM_MODES = ["survival", "deathmatch", "creative", "sandbox"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];
export type RoomVisibility = "public" | "unlisted";

export interface RoomRow {
  id: number;
  code: string;
  name: string;
  mode: RoomMode;
  config: Uint8Array;
  visibility: RoomVisibility;
  creatorPlayerId: number | null;
  createdAt: number;
  lastActive: number;
}

export interface CreateRoomOpts {
  name: string;
  mode: string;
  config: Uint8Array;
  visibility: string;
  creatorPlayerId: number | null;
}

export type CreateRoomResult = { ok: true; room: RoomRow } | { ok: false; reason: string };

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: a human may read this code aloud
function defaultGenCode(): string {
  const bytes = randomBytes(ROOM_CODE_LEN);
  let out = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export interface RoomsStoreOptions {
  /** Test hook: force a specific code sequence to exercise the collision-retry path. */
  genCode?: () => string;
  /** Test hook / clock injection. */
  now?: () => number;
}

function rowToRoom(r: {
  id: number;
  code: string;
  name: string;
  mode: string;
  config: Uint8Array;
  visibility: string;
  creator_player_id: number | null;
  created_at: number;
  last_active: number;
}): RoomRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    mode: r.mode as RoomMode,
    config: r.config,
    visibility: r.visibility as RoomVisibility,
    creatorPlayerId: r.creator_player_id,
    createdAt: r.created_at,
    lastActive: r.last_active,
  };
}

export class RoomsStore {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private readonly genCode: () => string;
  private readonly now: () => number;

  constructor(gameDb: GameDb, opts: RoomsStoreOptions = {}) {
    this.db = gameDb.db;
    this.genCode = opts.genCode ?? defaultGenCode;
    this.now = opts.now ?? Date.now;
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /**
   * Validate and insert a room. Rejects (never stores) on: a bad name, an unknown mode, a config
   * `decodeConfig` refuses, an unknown visibility, or the creator's daily rate limit. Retries on a code
   * collision (unique constraint), since a 6-character code from `crypto.randomBytes` can rarely repeat.
   */
  createRoom(opts: CreateRoomOpts): CreateRoomResult {
    const name = cleanName(opts.name).slice(0, MAX_ROOM_NAME_CHARS);
    if (name.length === 0) return { ok: false, reason: "bad_name" };
    if (!ROOM_MODES.includes(opts.mode as RoomMode)) return { ok: false, reason: "bad_mode" };
    const mode = opts.mode as RoomMode;
    if (opts.visibility !== "public" && opts.visibility !== "unlisted") return { ok: false, reason: "bad_visibility" };
    const visibility = opts.visibility as RoomVisibility;
    const cfg: RoomConfig | null = decodeConfig(opts.config);
    if (!cfg || opts.config.length !== CONFIG_BYTES) return { ok: false, reason: "bad_config" };
    if (opts.creatorPlayerId !== null && this.roomsCreatedSince(opts.creatorPlayerId, this.now() - DAY_MS) >= MAX_ROOMS_PER_CREATOR_PER_DAY) {
      return { ok: false, reason: "rate_limited" };
    }
    const now = this.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = this.genCode();
      try {
        const r = this.q(
          "insert into rooms (code, name, mode, config, visibility, creator_player_id, created_at, last_active) values (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(code, name, mode, opts.config, visibility, opts.creatorPlayerId, now, now);
        const id = Number(r.lastInsertRowid);
        return { ok: true, room: { id, code, name, mode, config: opts.config, visibility, creatorPlayerId: opts.creatorPlayerId, createdAt: now, lastActive: now } };
      } catch (e) {
        // A unique-constraint violation on `code` is the only expected failure here; anything else rethrows.
        if (String(e).includes("UNIQUE") && String(e).includes("code")) continue;
        throw e;
      }
    }
    return { ok: false, reason: "code_exhausted" };
  }

  private roomsCreatedSince(creatorPlayerId: number, sinceMs: number): number {
    return (
      this.q("select count(*) as n from rooms where creator_player_id = ? and created_at >= ?").get(creatorPlayerId, sinceMs) as { n: number }
    ).n;
  }

  getRoomById(id: number): RoomRow | null {
    const r = this.q("select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active from rooms where id = ?").get(id) as
      | Parameters<typeof rowToRoom>[0]
      | undefined;
    return r ? rowToRoom(r) : null;
  }

  /** Case-insensitive: the plan says "six characters, case-insensitive". */
  getRoomByCode(code: string): RoomRow | null {
    const r = this.q(
      "select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active from rooms where upper(code) = upper(?)",
    ).get(code) as Parameters<typeof rowToRoom>[0] | undefined;
    return r ? rowToRoom(r) : null;
  }

  /**
   * Public rooms, most recently active first, capped at `limit` (the capacity note's 100-stored-rooms cap
   * means this never needs to be huge, but an unbounded `select *` is still wrong).
   * TODO(R2b): sort by live player count first, then last_active — no room is joinable yet in R2a, so there
   * is no live count to sort by; inventing one here would be a fake number, not a placeholder worth shipping.
   */
  listPublicRooms(limit = 100): RoomRow[] {
    const rows = this.q(
      // `id desc` breaks ties: two rooms created in the same millisecond (Date.now() resolution) would
      // otherwise come back in an arbitrary order (sqlite doesn't guarantee one for equal sort keys).
      "select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active from rooms where visibility = 'public' order by last_active desc, id desc limit ?",
    ).all(limit) as Parameters<typeof rowToRoom>[0][];
    return rows.map(rowToRoom);
  }

  /** Count of stored rooms, grouped by mode (admin dashboard). */
  countsByMode(): Record<string, number> {
    const rows = this.q("select mode, count(*) as n from rooms group by mode").all() as { mode: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.mode, r.n]));
  }

  totalRooms(): number {
    return (this.q("select count(*) as n from rooms").get() as { n: number }).n;
  }
}
