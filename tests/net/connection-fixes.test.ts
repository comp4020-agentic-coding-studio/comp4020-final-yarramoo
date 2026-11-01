// F7 item 4: names after a resync, the resync budget, the liveness timeout (injected clock), incident pruning.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameDb, MAX_INCIDENT_ROWS } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { CLOSE_OUT_OF_SYNC, CLOSE_SILENT, LIVENESS_MS, RESYNC_BUDGET, RESYNC_BUDGET_MS, World, type Peer } from "../../server/world.ts";
import { decodeServer } from "../../shared/protocol.ts";
import { SURVIVAL } from "../../shared/room.ts";

function rig() {
  let t = 1000;
  const log = new EventLog({ quiet: true });
  const w = new World({ id: 901, cfg: { ...SURVIVAL, size: 0 }, now: () => t, log });
  const sent = new Map<number, string[]>();
  const closes: [number, number][] = [];
  const add = (pid: number) => {
    const frames: string[] = [];
    const p: Peer = {
      send: (f) => frames.push(decodeServer(f)?.t ?? "?"),
      buffered: () => 0,
      close: (code) => closes.push([pid, code]),
    };
    const names: string[] = [];
    const orig = p.send;
    p.send = (f) => {
      orig(f);
      const m = decodeServer(f);
      if (m?.t === "player-name") names.push(m.name);
    };
    const conn = w.join(p, { playerId: pid, name: `P${pid}`, visitorId: pid, visitorName: `P${pid}` }).conn;
    w.onLive(conn, w.clock.lastClosed);
    sent.set(conn, names);
    return { conn, frames, names };
  };
  return { w, add, closes, at: (v: number) => (t = v), now: () => t, adv: (ms: number) => { t += ms; w.tick(); } };
}
const resync = (w: World, conn: number) => (w as unknown as { resync(m: unknown): void }).resync(w.members.get(conn));

describe("names after a resync", () => {
  it("the server resends every PLAYER_NAME after a RESYNC, as after WELCOME", () => {
    const r = rig();
    const a = r.add(1);
    r.add(2);
    a.names.length = 0;
    resync(r.w, a.conn);
    expect(a.names.sort()).toEqual(["P1", "P2"]);
  });
});

describe("resync budget", () => {
  it("allows 3 resyncs a minute, closes the 4th with CLOSE_OUT_OF_SYNC, and forgives after the window", () => {
    const r = rig();
    const a = r.add(1);
    r.add(2);
    for (let i = 0; i < RESYNC_BUDGET; i++) resync(r.w, a.conn);
    expect(r.closes).toEqual([]);
    resync(r.w, a.conn);
    expect(r.closes).toEqual([[1, CLOSE_OUT_OF_SYNC]]);
    r.adv(10); // the dropped member leaves on the next tick
    expect(r.w.hasMember(a.conn)).toBe(false);
    // An honest player after a server hiccup: a fresh connection starts with a fresh budget.
    const again = r.add(1);
    resync(r.w, again.conn);
    r.at(r.now() + RESYNC_BUDGET_MS + 1);
    for (let i = 0; i < RESYNC_BUDGET; i++) resync(r.w, again.conn);
    expect(r.closes).toHaveLength(1);
  });
});

describe("liveness timeout", () => {
  it("closes a live member silent for 10 s with CLOSE_SILENT, keeps one that keeps talking, and spares a catching-up one", () => {
    const r = rig();
    const quiet = r.add(1);
    const chatty = r.add(2);
    r.adv(LIVENESS_MS - 1000);
    r.w.heard(chatty.conn);
    r.adv(500);
    expect(r.closes).toEqual([]);
    r.adv(1500);
    expect(r.closes).toEqual([[1, CLOSE_SILENT]]);
    r.adv(10); // dropped members leave at the start of the next tick
    expect(r.w.hasMember(quiet.conn)).toBe(false);
    expect(r.w.hasMember(chatty.conn)).toBe(true);
    // not live yet (replaying): exempt however long it takes
    const p: Peer = { send() {}, buffered: () => 0, close: (c) => r.closes.push([9, c]) };
    const slow = r.w.join(p, { playerId: 3, name: "P3", visitorId: 3, visitorName: "P3" }).conn;
    r.w.members.get(slow)!.live = false;
    r.adv(LIVENESS_MS * 3);
    expect(r.closes.filter(([id]) => id === 9)).toEqual([]);
  });
});

describe("incident pruning", () => {
  it("keeps only the newest MAX_INCIDENT_ROWS", () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-inc-"));
    try {
      const db = new GameDb(dir);
      for (let i = 0; i < MAX_INCIDENT_ROWS + 25; i++) db.recordIncident(1, i, { i });
      const rows = db.recentIncidents(5000);
      expect(rows).toHaveLength(MAX_INCIDENT_ROWS);
      expect(rows[0].tick).toBe(MAX_INCIDENT_ROWS + 24);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
