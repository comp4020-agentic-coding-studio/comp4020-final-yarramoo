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
/** Modes a new room may be created with. Creative was removed (4 Nov: "just the sandbox is fine"); old Creative
 * rows stay loadable (the DB check constraint still allows them), they just cannot be made any more. */
export const CREATABLE_MODES = ["survival", "deathmatch", "sandbox"] as const;
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
  /** F7: when a majority said the round ended, else null. */
  endedAt: number | null;
  /** OWNED: the player whose persistent sandbox this is, else null (an ephemeral room the sweep deletes). */
  ownerPlayerId: number | null;
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
  ended_at: number | null;
  owner_player_id: number | null;
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
    endedAt: r.ended_at ?? null,
    ownerPlayerId: r.owner_player_id ?? null,
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
    if (opts.mode === "creative") return { ok: false, reason: "mode_retired" };
    if (!ROOM_MODES.includes(opts.mode as RoomMode) || !(CREATABLE_MODES as readonly string[]).includes(opts.mode)) return { ok: false, reason: "bad_mode" };
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
        return { ok: true, room: { id, code, name, mode, config: opts.config, visibility, creatorPlayerId: opts.creatorPlayerId, createdAt: now, lastActive: now, endedAt: null, ownerPlayerId: null } };
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
    const r = this.q("select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active, ended_at, owner_player_id from rooms where id = ?").get(id) as
      | Parameters<typeof rowToRoom>[0]
      | undefined;
    return r ? rowToRoom(r) : null;
  }

  /** N1: a member is in the room now. `last_active` becomes "the last moment anyone was in it". */
  touch(id: number, nowMs: number): void {
    this.q("update rooms set last_active = ? where id = ?").run(nowMs, id);
  }

  /** N1: the first member arrived (kept forever; decides never_joined vs empty). */
  markJoined(id: number, nowMs: number): void {
    this.q("update rooms set last_active = ?, first_joined_at = coalesce(first_joined_at, ?) where id = ?").run(nowMs, nowMs, id);
  }

  /**
   * N1: real rooms (ids above the two reserved fixed-world rows) past their grace period by the STORED times: never
   * joined and created more than `neverMs` ago, or joined and `last_active` more than `unloadMs` ago.
   */
  staleRooms(nowMs: number, unloadMs: number, neverMs: number): { id: number; mode: string; reason: "empty" | "never_joined" }[] {
    const rows = this.q(
      `select id, mode, first_joined_at from rooms where id > 1 and owner_player_id is null and
         ((first_joined_at is null and created_at < ?) or (first_joined_at is not null and last_active < ?))`,
    ).all(nowMs - neverMs, nowMs - unloadMs) as { id: number; mode: string; first_joined_at: number | null }[];
    return rows.map((r) => ({ id: r.id, mode: r.mode, reason: r.first_joined_at === null ? "never_joined" : "empty" }));
  }

  /** N1: delete a room and everything keyed by it in one transaction. Player stats and achievements stay. */
  deleteRoom(id: number): boolean {
    if (id <= 1) return false; // the fixed worlds' rows never die
    this.db.exec("BEGIN");
    try {
      this.q("delete from snapshots where world_id = ?").run(id);
      this.q("delete from tick_log where world_id = ?").run(id);
      this.q("delete from desync_incidents where world_id = ?").run(id);
      this.q("delete from worlds where id = ?").run(id);
      const n = Number(this.q("delete from rooms where id = ?").run(id).changes);
      this.db.exec("COMMIT");
      return n > 0;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** OWNED: the player's own sandbox, or null. */
  ownedBy(playerId: number): RoomRow | null {
    const r = this.q(
      "select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active, ended_at, owner_player_id from rooms where owner_player_id = ?",
    ).get(playerId) as Parameters<typeof rowToRoom>[0] | undefined;
    return r ? rowToRoom(r) : null;
  }

  /**
   * OWNED: return the player's sandbox, creating it on the first call (idempotent: one per player, enforced by the
   * `rooms_owner` unique index as well as this lookup). Always the classic sandbox config, always unlisted (link-only),
   * never counted against the 3-a-day room limit (it is one row for life). `created` says which happened.
   */
  ensureOwned(playerId: number, ownerName: string, config: Uint8Array): { room: RoomRow; created: boolean } | { error: string } {
    const existing = this.ownedBy(playerId);
    if (existing) return { room: existing, created: false };
    // "Mitch's world": the owner's plain name (cleaned, at most 24 characters) plus 8 always fits the 32 a room name may have.
    const clean = `${cleanName(ownerName)}'s world`.slice(0, MAX_ROOM_NAME_CHARS);
    if (clean.length === 0) return { error: "bad_name" };
    if (!decodeConfig(config) || config.length !== CONFIG_BYTES) return { error: "bad_config" };
    const now = this.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = this.genCode();
      try {
        const r = this.q(
          "insert into rooms (code, name, mode, config, visibility, creator_player_id, created_at, last_active, owner_player_id) values (?, ?, 'sandbox', ?, 'unlisted', ?, ?, ?, ?)",
        ).run(code, clean, config, playerId, now, now, playerId);
        // An owner is kept like a player who joined: `evictUnjoined` must never delete a registration a room row
        // references (the foreign key would throw there and refuse every registration at the cap).
        this.q("update players set joined_at = coalesce(joined_at, ?) where id = ?").run(now, playerId);
        return { room: this.getRoomById(Number(r.lastInsertRowid))!, created: true };
      } catch (e) {
        const m = String(e);
        if (m.includes("UNIQUE") && m.includes("code")) continue;
        // Two creates for one player racing: the index refused the second; hand back the first's row.
        if (m.includes("UNIQUE") && m.includes("owner_player_id")) {
          const won = this.ownedBy(playerId);
          if (won) return { room: won, created: false };
        }
        throw e;
      }
    }
    return { error: "code_exhausted" };
  }

  /** Case-insensitive: the plan says "six characters, case-insensitive". */
  getRoomByCode(code: string): RoomRow | null {
    const r = this.q(
      "select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active, ended_at, owner_player_id from rooms where upper(code) = upper(?)",
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
      "select id, code, name, mode, config, visibility, creator_player_id, created_at, last_active, ended_at, owner_player_id from rooms where visibility = 'public' and ended_at is null and owner_player_id is null order by last_active desc, id desc limit ?",
    ).all(limit) as Parameters<typeof rowToRoom>[0][];
    return rows.map(rowToRoom);
  }

  /** F7: mark a room's round over (idempotent: the first time wins). */
  markEnded(id: number): void {
    this.q("update rooms set ended_at = ? where id = ? and ended_at is null").run(this.now(), id);
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
