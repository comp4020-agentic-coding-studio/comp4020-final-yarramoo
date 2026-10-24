// M6 slice a: the achievement table, migration 5, the db methods and eviction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ACHIEVEMENTS, SERVER_ACHIEVEMENTS, achievementById } from "../../shared/achievements.ts";
import { GameDb } from "../../server/db.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-ach-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const check = (id: string, stats: Record<string, number>) => {
  const a = achievementById(id)!;
  if (a.source !== "server") throw new Error("not a server achievement");
  return a.check(stats);
};

describe("the achievement table", () => {
  it("has six server entries and four claim entries with unique ids", () => {
    expect(SERVER_ACHIEVEMENTS.map((a) => a.id)).toEqual(["first_spell", "gardener", "waterworks", "pyromaniac", "demolitionist", "spelunker"]);
    expect(ACHIEVEMENTS.filter((a) => a.source === "claim").map((a) => a.name)).toEqual(["First blood", "Shoved to their doom", "Five kills", "Back from the dead"]);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(10);
  });
  it("thresholds are exact", () => {
    expect(check("waterworks", { casts_water: 99 })).toBe(false);
    expect(check("waterworks", { casts_water: 100 })).toBe(true);
    expect(check("gardener", { casts_rose: 99 })).toBe(false);
    expect(check("gardener", { casts_rose: 100 })).toBe(true);
    expect(check("pyromaniac", { casts_fire: 49 })).toBe(false);
    expect(check("pyromaniac", { casts_fire: 50 })).toBe(true);
    expect(check("demolitionist", { casts_bomb: 24 })).toBe(false);
    expect(check("demolitionist", { casts_bomb: 25 })).toBe(true);
    expect(check("spelunker", { max_depth: 799 })).toBe(false);
    expect(check("spelunker", { max_depth: 800 })).toBe(true);
    expect(check("first_spell", {})).toBe(false);
    expect(check("first_spell", { casts_push: 1 })).toBe(true);
  });
});

describe("migration 5", () => {
  it("applies on top of a version-4 database and keeps the old rows", () => {
    const dir = tmp();
    const raw = new DatabaseSync(join(dir, "game.db"));
    raw.exec(`create table worlds (id integer primary key, kind text not null check (kind in ('sandbox','game')), seed integer not null, sim_build text not null, last_tick integer not null default 0, next_player integer not null default 1, created_at integer not null);
      create table snapshots (world_id integer not null references worlds(id), tick integer not null, state_hash integer not null, sim_build text not null, format_version integer not null, data blob not null, keep_for_timelapse integer not null default 0, created_at integer not null, primary key (world_id, tick));
      create table tick_log (world_id integer not null references worlds(id), first_tick integer not null, last_tick integer not null, sim_build text not null, data blob not null, primary key (world_id, first_tick));
      create table desync_incidents (id integer primary key, world_id integer, tick integer, details text, created_at integer);
      create table players (id integer primary key, display_name text not null, token_hash text unique not null, created_at integer not null, last_seen integer);
      alter table players add column joined_at integer;
      create table player_stats (player_id integer references players(id), stat text not null, value integer not null default 0, primary key (player_id, stat));
      insert into players (display_name, token_hash, created_at) values ('Old', 'abc', 1);
      insert into player_stats (player_id, stat, value) values (1, 'casts_water', 7);
      PRAGMA user_version = 4;`);
    raw.close();
    const db = new GameDb(dir);
    expect(db.schemaVersion).toBe(6); // migration 6 (rooms, R2a) also applied
    expect(db.loadStats(1)).toEqual({ casts_water: 7 });
    expect(db.achievementsOf(1)).toEqual([]);
    expect(db.awardAchievement(1, "first_spell", 1, 10)).toBe(true);
    expect(db.achievementsOf(1)).toEqual(["first_spell"]);
    db.close();
  });
});

describe("db awards", () => {
  it("awarding is idempotent and lists recent awards newest first with the plain name", () => {
    const db = new GameDb(tmp());
    const a = db.createPlayer("Ana", "h1");
    const b = db.createPlayer("Bo", "h2");
    expect(db.awardAchievement(a, "first_spell", 1, 5)).toBe(true);
    expect(db.awardAchievement(a, "first_spell", 0, 99)).toBe(false);
    expect(db.awardAchievement(b, "waterworks", 1, 7)).toBe(true);
    expect(db.achievementsOf(a)).toEqual(["first_spell"]);
    const recent = db.recentAchievements(10);
    expect(recent.map((r) => [r.name, r.achievement, r.tick])).toEqual([["Bo", "waterworks", 7], ["Ana", "first_spell", 5]]);
    expect(db.recentAchievements(1)).toHaveLength(1);
    expect(db.achievementsSince(0)).toBe(2);
    expect(db.achievementsSince(Date.now() + 10_000)).toBe(0);
    db.close();
  });
});

describe("eviction", () => {
  it("removes achievement rows with the unjoined player, and keeps a joined player's", () => {
    const db = new GameDb(tmp());
    const idle = db.createPlayer("Idle", "h1");
    const real = db.createPlayer("Real", "h2");
    db.touchPlayer(real);
    db.awardAchievement(idle, "first_spell", 1, 1);
    db.awardAchievement(real, "first_spell", 1, 1);
    db.upsertStats([{ playerId: idle, stat: "casts_push", value: 1 }]);
    expect(db.evictUnjoined(Date.now() + 1000)).toBe(1);
    expect(db.achievementsOf(idle)).toEqual([]);
    expect(db.achievementsOf(real)).toEqual(["first_spell"]);
    expect(db.playerCount()).toBe(1);
    db.close();
  });
});
