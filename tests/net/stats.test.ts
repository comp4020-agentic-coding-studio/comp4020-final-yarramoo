// Slice 2: per-player stats (migration 4, PlayerStats, flush), input.summary and the leave summary.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GameDb } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { PlayerStats } from "../../server/stats.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-stats-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string | null, inputSummaryMs?: number): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, inputSummaryMs });
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;

describe("migration 4", () => {
  it("applies on top of a version-3 database and keeps the old rows", () => {
    const dir = tmp();
    // Build a v3 database by hand: the three migrations as they shipped, then a player row.
    const raw = new DatabaseSync(join(dir, "game.db"));
    raw.exec(`create table worlds (id integer primary key, kind text not null check (kind in ('sandbox','game')), seed integer not null, sim_build text not null, last_tick integer not null default 0, next_player integer not null default 1, created_at integer not null);
      create table snapshots (world_id integer not null references worlds(id), tick integer not null, state_hash integer not null, sim_build text not null, format_version integer not null, data blob not null, keep_for_timelapse integer not null default 0, created_at integer not null, primary key (world_id, tick));
      create table tick_log (world_id integer not null references worlds(id), first_tick integer not null, last_tick integer not null, sim_build text not null, data blob not null, primary key (world_id, first_tick));
      create table desync_incidents (id integer primary key, world_id integer, tick integer, details text, created_at integer);
      create table players (id integer primary key, display_name text not null, token_hash text unique not null, created_at integer not null, last_seen integer);
      alter table players add column joined_at integer;
      insert into players (display_name, token_hash, created_at) values ('Old', 'abc', 1);
      PRAGMA user_version = 3;`);
    raw.close();
    const db = new GameDb(dir);
    expect(db.schemaVersion).toBe(5); // migrations 4 and 5 both applied
    expect(db.playerByTokenHash("abc")).toEqual({ id: 1, displayName: "Old" });
    db.upsertStats([{ playerId: 1, stat: "casts_push", value: 3 }]);
    db.upsertStats([{ playerId: 1, stat: "casts_push", value: 5 }]);
    expect(db.loadStats(1)).toEqual({ casts_push: 5 });
    db.close();
  });
});

describe("flush failures", () => {
  it("one bad row does not block the others, and the failure is logged once", () => {
    const dir = tmp();
    const db = new GameDb(dir);
    const id = db.createPlayer("Real", "h1");
    const log = new EventLog({ quiet: true });
    const ps = new PlayerStats(db, log);
    ps.bump(id, "casts_push", 2);
    ps.bump(9999, "casts_push", 1); // no such player: the foreign key refuses it
    ps.flush();
    ps.flush();
    expect(db.loadStats(id)).toEqual({ casts_push: 2 });
    expect(log.recent().filter((e) => e.ev === "tick_log.flush_failed")).toHaveLength(1);
    db.close();
  });
});

describe("player stats", () => {
  it("counts casts, paints and depth, flushes at shutdown, and a reload adds to the totals", async () => {
    const dir = tmp();
    const s1 = await boot(dir);
    const me = await register(s1.port, "Counter");
    const sb = await connect(s1.port, hex, { world: 0, token: me.token });
    sb.paint(4, 100, 50, 140, 50, 6);
    sb.paint(4, 100, 60, 140, 60, 6);
    sb.paint(5, 100, 70, 140, 70, 6);
    const g = await connect(s1.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    g.cast(0, 100, 1);
    await sleep(120);
    g.cast(2, 100, 2);
    await sleep(120);
    g.cast(2, 100, 3);
    g.move(100, 120);
    await sleep(150);
    // Not written per input: the live row is allowed to lag, but memory is current.
    expect(s1.playerStats.get(me.id)).toMatchObject({ paints_sand: 2, paints_water: 1, casts_push: 1, casts_water: 2, max_depth: 120, sessions: 2 });
    sb.close();
    g.close();
    await sleep(100);
    await s1.close();
    const check = new GameDb(dir);
    const rows = check.loadStats(me.id);
    check.close();
    expect(rows).toMatchObject({ paints_sand: 2, paints_water: 1, casts_push: 1, casts_water: 2, max_depth: 120, sessions: 2 });
    expect(rows.play_ms).toBeGreaterThan(0);

    const s2 = await boot(dir);
    const again = await connect(s2.port, hex, { world: 0, token: me.token });
    again.paint(4, 100, 50, 140, 50, 6);
    await sleep(100);
    again.close();
    await sleep(100);
    expect(s2.playerStats.get(me.id)).toMatchObject({ paints_sand: 3, sessions: 3 });
  });

  it("anonymous connections create no stats", async () => {
    const s = await boot(tmp());
    const c = await connect(s.port, hex, { world: 0 });
    c.paint(4, 100, 50, 140, 50, 6);
    await sleep(100);
    c.close();
    await sleep(100);
    expect(s.playerStats.get(0)).toEqual({});
    expect(s.db!.db.prepare("select count(*) as n from player_stats").get()).toEqual({ n: 0 });
  });
});

describe("input.summary and the leave summary", () => {
  it("emits periodic summaries with counts, a final one on leave, and no per-cast events", async () => {
    const s = await boot(tmp(), 400);
    const me = await register(s.port, "Sum");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    g.cast(0, 100, 1);
    await sleep(120);
    g.cast(2, 100, 2);
    await sleep(120);
    g.cast(2, 100, 3);
    await waitFor(() => s.log.recent().some((e) => e.ev === "input.summary"), 3000, "a periodic summary");
    // Move and leave straight after a periodic summary, well inside the next 400 ms window, so the final one is non-empty.
    g.move(100, 130);
    g.close();
    await waitFor(() => s.log.recent().some((e) => e.ev === "leave"), 3000, "leave");
    const ev = s.log.recent();
    expect(ev.some((e) => (e.ev as string) === "cast")).toBe(false);
    const sums = ev.filter((e) => e.ev === "input.summary");
    expect(sums.every((e) => e.who === `Sum#${me.id}`)).toBe(true);
    const total = (k: "pos") => sums.reduce((n, e) => n + Number(e[k]), 0);
    expect(total("pos")).toBe(2);
    // Windows are disjoint, so the per-window counts add up to the session's.
    const tally: Record<string, number> = {};
    for (const part of sums.map((e) => e.casts).filter(Boolean).join(",").split(",")) {
      const [k, n] = part.split(":");
      tally[k] = (tally[k] ?? 0) + Number(n);
    }
    expect(tally).toEqual({ push: 1, water: 2 });
    // The final window is emitted synchronously on leave, right after the leave event.
    expect(ev.at(-1)).toMatchObject({ ev: "input.summary", final: true });
    const leave = ev.find((e) => e.ev === "leave")!;
    expect(leave).toMatchObject({ who: `Sum#${me.id}`, casts: "push:1,water:2", max_depth: 130, resyncs: 0, pos_rejected: 0 });
    expect(leave.duration_s).toBeDefined();
    expect(leave.paints).toBe("");
  });

  it("counts a sandbox painter's paints by material", async () => {
    const s = await boot(tmp(), 100000);
    const me = await register(s.port, "Pat");
    const sb = await connect(s.port, hex, { world: 0, token: me.token });
    sb.paint(4, 100, 50, 140, 50, 6);
    sb.paint(4, 100, 60, 140, 60, 6);
    sb.paint(5, 100, 70, 140, 70, 6);
    await sleep(100);
    sb.close();
    await waitFor(() => s.log.recent().some((e) => e.ev === "leave"), 3000, "leave");
    expect(s.log.recent().find((e) => e.ev === "leave")).toMatchObject({ role: "painter", paints: "sand:2,water:1", casts: "" });
    expect(s.log.recent().find((e) => e.ev === "input.summary")).toMatchObject({ paints: "sand:2,water:1", final: true });
  });

  it("counts a rejected Pos (a teleport) in the leave summary, summary and stats", async () => {
    const s = await boot(tmp(), 100000);
    const me = await register(s.port, "Tele");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    await sleep(100);
    g.move(1500, 1400); // far beyond what one avatar can cover
    await sleep(150);
    g.close();
    await waitFor(() => s.log.recent().some((e) => e.ev === "leave"), 3000, "leave");
    expect(s.log.recent().find((e) => e.ev === "leave")).toMatchObject({ pos_rejected: 1 });
    expect(s.log.recent().find((e) => e.ev === "input.summary")).toMatchObject({ pos: 1, rejected: 1 });
    expect(s.playerStats.get(me.id).pos_rejected).toBe(1);
  });

  it("a replaced tab cannot stamp inputs or bump stats, and its leave is logged once", async () => {
    const s = await boot(tmp(), 100000);
    const me = await register(s.port, "Twice");
    const a = await connect(s.port, hex, { world: GAME, token: me.token });
    const b = await connect(s.port, hex, { world: GAME, token: me.token });
    await waitFor(() => a.ws.readyState === a.ws.CLOSED, 5000, "first closed");
    const before = s.playerStats.get(me.id).casts_push ?? 0;
    a.cast(0, 100, 1); // sent on the old socket: ignored (or already closed)
    b.move(100, 100);
    await sleep(100);
    b.cast(0, 100, 1);
    await sleep(100);
    expect((s.playerStats.get(me.id).casts_push ?? 0) - before).toBe(1);
    b.close();
    await waitFor(() => s.log.recent().filter((e) => e.ev === "leave").length === 2, 3000, "two leaves");
    expect(s.log.recent().filter((e) => e.ev === "leave")).toHaveLength(2);
  });
});
