// SQLite persistence for the game server (plan 9.1/9.2). A separate file (game.db) from the course app's
// app.db. Synchronous node:sqlite on the same thread: every write is a few KB or one snapshot, WAL with
// synchronous=NORMAL, and the clock catches up on late timers, so a flush can never skip or misfile a tick.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOTS_KEPT = 5;
export const SNAPSHOT_FORMAT_VERSION = 2;

/** Applied in order; PRAGMA user_version is the number applied. Append only, never edit. */
const MIGRATIONS: string[] = [
  `
  create table worlds (
    id integer primary key,
    kind text not null check (kind in ('sandbox','game')),
    seed integer not null,
    sim_build text not null,
    last_tick integer not null default 0,
    next_player integer not null default 1,
    created_at integer not null
  );
  create table snapshots (
    world_id integer not null references worlds(id),
    tick integer not null,
    state_hash integer not null,
    sim_build text not null,
    format_version integer not null,
    data blob not null,
    keep_for_timelapse integer not null default 0,
    created_at integer not null,
    primary key (world_id, tick)
  );
  create table tick_log (
    world_id integer not null references worlds(id),
    first_tick integer not null,
    last_tick integer not null,
    sim_build text not null,
    data blob not null,
    primary key (world_id, first_tick)
  );
  create table desync_incidents (
    id integer primary key,
    world_id integer, tick integer, details text, created_at integer
  );
  `,
  // M4a identity (plan 9.1): only sha256(token) is stored. The id is the sim's player id in the game world.
  `
  create table players (
    id integer primary key,
    display_name text not null,
    token_hash text unique not null,
    created_at integer not null,
    last_seen integer
  );
  `,
];

export interface WorldRow {
  id: number;
  kind: string;
  seed: bigint;
  simBuild: string;
  lastTick: number;
  nextPlayer: number;
}

export interface StoredSnapshot {
  tick: number;
  hash: bigint;
  simBuild: string;
  data: Uint8Array;
}

export interface TickBatch {
  first: number;
  last: number;
  data: Uint8Array;
}

export class GameDb {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(dir: string, file = "game.db") {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(file === ":memory:" ? file : join(dir, file));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  get schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  getWorld(id: number): WorldRow | null {
    const s = this.q("select id, kind, seed, sim_build, last_tick, next_player from worlds where id = ?");
    s.setReadBigInts(true);
    const r = s.get(id) as { id: bigint; kind: string; seed: bigint; sim_build: string; last_tick: bigint; next_player: bigint } | undefined;
    return r ? { id: Number(r.id), kind: r.kind, seed: r.seed, simBuild: r.sim_build, lastTick: Number(r.last_tick), nextPlayer: Number(r.next_player) } : null;
  }

  createWorld(id: number, kind: "sandbox" | "game", seed: bigint, simBuild: string): void {
    this.q("insert into worlds (id, kind, seed, sim_build, last_tick, created_at) values (?, ?, ?, ?, 0, ?)").run(
      id, kind, BigInt.asIntN(64, seed), simBuild, Date.now(),
    );
  }

  setWorldBuild(id: number, simBuild: string): void {
    this.q("update worlds set sim_build = ? where id = ?").run(simBuild, id);
  }

  setNextPlayer(id: number, next: number): void {
    this.q("update worlds set next_player = ? where id = ?").run(next, id);
  }

  /** Forget history (a new sim build that cannot load the old snapshot): tick numbering restarts at 0. */
  resetWorld(id: number, simBuild: string): void {
    this.db.exec("BEGIN");
    try {
      this.q("delete from snapshots where world_id = ?").run(id);
      this.q("delete from tick_log where world_id = ?").run(id);
      this.q("update worlds set last_tick = 0, sim_build = ? where id = ?").run(simBuild, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  setLastTick(id: number, tick: number): void {
    this.q("update worlds set last_tick = ? where id = ?").run(tick, id);
  }

  /** One row per batch; data is the concatenated encoded TICK frames for [first, last]. */
  appendTicks(worldId: number, first: number, last: number, simBuild: string, data: Uint8Array): void {
    this.db.exec("BEGIN");
    try {
      this.q("insert into tick_log (world_id, first_tick, last_tick, sim_build, data) values (?, ?, ?, ?, ?)").run(
        worldId, first, last, simBuild, data,
      );
      this.setLastTick(worldId, last);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Batches that contain any tick after `tick`, in order. */
  ticksAfter(worldId: number, tick: number): TickBatch[] {
    const rows = this.q(
      "select first_tick, last_tick, data from tick_log where world_id = ? and last_tick > ? order by first_tick",
    ).all(worldId, tick) as { first_tick: number; last_tick: number; data: Uint8Array }[];
    return rows.map((r) => ({ first: r.first_tick, last: r.last_tick, data: r.data }));
  }

  clearTickLog(worldId: number): void {
    this.q("delete from tick_log where world_id = ?").run(worldId);
  }

  saveSnapshot(worldId: number, s: StoredSnapshot): void {
    this.db.exec("BEGIN");
    try {
      this.q(
        "insert or replace into snapshots (world_id, tick, state_hash, sim_build, format_version, data, keep_for_timelapse, created_at) values (?, ?, ?, ?, ?, ?, 0, ?)",
      ).run(worldId, s.tick, BigInt.asIntN(64, s.hash), s.simBuild, SNAPSHOT_FORMAT_VERSION, s.data, Date.now());
      this.prune(worldId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Keep the newest SNAPSHOTS_KEPT (plus timelapse-flagged), then drop tick_log batches wholly before the oldest kept. */
  private prune(worldId: number): void {
    this.q(
      `delete from snapshots where world_id = ? and keep_for_timelapse = 0 and tick not in
         (select tick from snapshots where world_id = ? order by tick desc limit ${SNAPSHOTS_KEPT})`,
    ).run(worldId, worldId);
    const oldest = this.q(
      "select min(tick) as t from (select tick from snapshots where world_id = ? order by tick desc limit ?)",
    ).get(worldId, SNAPSHOTS_KEPT) as { t: number | null };
    if (oldest.t !== null) this.q("delete from tick_log where world_id = ? and last_tick <= ?").run(worldId, oldest.t);
  }

  latestSnapshot(worldId: number): StoredSnapshot | null {
    const s = this.q(
      "select tick, state_hash, sim_build, data from snapshots where world_id = ? order by tick desc limit 1",
    );
    s.setReadBigInts(true);
    const r = s.get(worldId) as { tick: bigint; state_hash: bigint; sim_build: string; data: Uint8Array } | undefined;
    return r ? { tick: Number(r.tick), hash: BigInt.asUintN(64, r.state_hash), simBuild: r.sim_build, data: r.data } : null;
  }

  snapshotTicks(worldId: number): number[] {
    return (this.q("select tick from snapshots where world_id = ? order by tick").all(worldId) as { tick: number }[]).map((r) => r.tick);
  }

  /** Create a player; returns its id (the sim's player_id). */
  createPlayer(displayName: string, tokenHash: string): number {
    const r = this.q("insert into players (display_name, token_hash, created_at, last_seen) values (?, ?, ?, ?)").run(
      displayName, tokenHash, Date.now(), Date.now(),
    );
    return Number(r.lastInsertRowid);
  }

  playerByTokenHash(tokenHash: string): { id: number; displayName: string } | null {
    const r = this.q("select id, display_name from players where token_hash = ?").get(tokenHash) as { id: number; display_name: string } | undefined;
    return r ? { id: r.id, displayName: r.display_name } : null;
  }

  playerCount(): number {
    return (this.q("select count(*) as n from players").get() as { n: number }).n;
  }

  touchPlayer(id: number): void {
    this.q("update players set last_seen = ? where id = ?").run(Date.now(), id);
  }

  playerNames(ids: number[]): Record<number, string> {
    const out: Record<number, string> = {};
    for (const id of ids) {
      const r = this.q("select display_name from players where id = ?").get(id) as { display_name: string } | undefined;
      if (r) out[id] = r.display_name;
    }
    return out;
  }

  recordIncident(worldId: number, tick: number, details: unknown): void {
    this.q("insert into desync_incidents (world_id, tick, details, created_at) values (?, ?, ?, ?)").run(
      worldId, tick, JSON.stringify(details), Date.now(),
    );
  }

  incidents(worldId: number): { tick: number; details: Record<string, unknown> }[] {
    const rows = this.q("select tick, details from desync_incidents where world_id = ? order by id").all(worldId) as { tick: number; details: string }[];
    return rows.map((r) => ({ tick: r.tick, details: JSON.parse(r.details) }));
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }
}
