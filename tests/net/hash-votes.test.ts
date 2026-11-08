// Review 8 Nov, H1 and M1: who defines the majority hash, who supplies a snapshot, and how much state a spray of
// HASH frames can open. Unit tests on World with fake peers and a hand-driven clock; no sockets, no sim.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GameDb } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { HASH_WINDOW_TICKS, SANDBOX_ID, World, type Peer } from "../../server/world.ts";
import { HASH_EVERY, S_REQUEST_SNAPSHOT } from "../../shared/protocol.ts";
import { CAVES_PVP } from "../../shared/room.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});

interface FakePeer extends Peer {
  sent: Uint8Array[];
  closed: string | null;
}
const fakePeer = (): FakePeer => {
  const p: FakePeer = {
    sent: [],
    closed: null,
    send(f) {
      p.sent.push(f);
    },
    buffered: () => 0,
    close(_code, reason) {
      p.closed = reason;
    },
    userAgent: "fake",
  };
  return p;
};

const GOOD = 0x600dn;
const BAD = 0xbadn;

/** A world with a database (so it asks for snapshots), driven by a hand clock `t.ms`. */
function world(kind: "game" | "sandbox") {
  const t = { ms: 1000 };
  const dir = mkdtempSync(join(tmpdir(), "sand-hashvotes-"));
  const db = new GameDb(dir);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  const log = new EventLog({ quiet: true });
  const w = new World(kind === "game" ? { id: 77, cfg: CAVES_PVP, now: () => t.ms, log, db } : { id: SANDBOX_ID, now: () => t.ms, log, db });
  return { w, t, log };
}

/** Close ticks until lastClosed reaches `tick` (60 Hz). */
function runTo(w: World, t: { ms: number }, tick: number) {
  while (w.clock.lastClosed < tick) {
    t.ms += 1000 / 60;
    for (const id of w.members.keys()) w.heard(id); // the liveness reaper must not drop the fake peers
    w.tick();
  }
}

/** Join and make live; returns the connection id and its peer. */
function joinAs(w: World, opts: Parameters<World["join"]>[1]) {
  const peer = fakePeer();
  const { conn } = w.join(peer, opts);
  w.onLive(conn, w.clock.lastClosed);
  return { conn, peer };
}

describe("H1: hash votes count registered players, not sockets", () => {
  it("in a game world, three spectators agreeing on a wrong hash do not resync the one player", () => {
    const { w, t } = world("game");
    // The player connects first; the spectators after. Before the fix they were three votes to one.
    const player = joinAs(w, { playerId: 5, name: "Ann", visitorId: 5, visitorName: "Ann" });
    const specs = [0, 1, 2].map(() => joinAs(w, { spectate: true }));
    runTo(w, t, HASH_EVERY + 1);
    const tick = HASH_EVERY;
    for (const s of specs) w.onHash(s.conn, tick, BAD);
    w.onHash(player.conn, tick, GOOD);
    t.ms += 3000;
    w.tick();
    expect(w.stats.resyncs, "only the spectators are resynced").toBe(3);
    expect(w.members.get(player.conn)!.live, "the player was not sent a RESYNC").toBe(true);
    expect(player.peer.closed).toBeNull();
  });

  it("a spectator who connected first does not win a 1-1 tie against a player", () => {
    const { w, t } = world("game");
    const spec = joinAs(w, { spectate: true });
    const player = joinAs(w, { playerId: 9, name: "Bo", visitorId: 9, visitorName: "Bo" });
    runTo(w, t, HASH_EVERY + 1);
    w.onHash(spec.conn, HASH_EVERY, BAD);
    w.onHash(player.conn, HASH_EVERY, GOOD);
    t.ms += 3000;
    w.tick();
    expect(w.members.get(player.conn)!.live).toBe(true);
    expect(w.members.get(spec.conn)!.live, "the spectator is the one resynced").toBe(false);
  });

  it("a checkpoint does not wait for a spectator that never reports", () => {
    const { w, t } = world("game");
    const a = joinAs(w, { playerId: 1, name: "A", visitorId: 1, visitorName: "A" });
    const b = joinAs(w, { playerId: 2, name: "B", visitorId: 2, visitorName: "B" });
    joinAs(w, { spectate: true });
    runTo(w, t, HASH_EVERY + 1);
    w.onHash(a.conn, HASH_EVERY, GOOD);
    w.onHash(b.conn, HASH_EVERY, GOOD);
    expect(w.stats.hashPasses, "resolved at once, not after HASH_WAIT_MS").toBe(1);
  });

  it("a spectator is never asked for the snapshot, even when it is the longest connected", () => {
    const { w, t } = world("game");
    const spec = joinAs(w, { spectate: true });
    const player = joinAs(w, { playerId: 3, name: "C", visitorId: 3, visitorName: "C" });
    runTo(w, t, HASH_EVERY + 1);
    // Both live and hashing recently (requestSnapshot's liveness test).
    w.onHash(spec.conn, HASH_EVERY, GOOD);
    w.onHash(player.conn, HASH_EVERY, GOOD);
    expect(w.requestSnapshot()).toBe(true);
    const asked = (p: FakePeer) => p.sent.some((f) => f[0] === S_REQUEST_SNAPSHOT);
    expect(asked(spec.peer), "the spectator was asked").toBe(false);
    expect(asked(player.peer)).toBe(true);
  });

  it("with only spectators reporting, no truth is set and nobody is resynced", () => {
    const { w, t } = world("game");
    joinAs(w, { playerId: 4, name: "D", visitorId: 4, visitorName: "D" });
    const specs = [0, 1].map(() => joinAs(w, { spectate: true }));
    runTo(w, t, HASH_EVERY + 1);
    for (const s of specs) w.onHash(s.conn, HASH_EVERY, BAD);
    t.ms += 3000;
    w.tick();
    expect(w.stats.resyncs).toBe(0);
    expect(w.hashState().truth).toBe(0);
  });

  it("in the sandbox, many sockets from one address are one vote", () => {
    const { w, t } = world("sandbox");
    const honest = [joinAs(w, { ipTag: "aaaaaa" }), joinAs(w, { ipTag: "bbbbbb" })];
    const sybils = [0, 1, 2, 3, 4].map(() => joinAs(w, { ipTag: "cccccc" }));
    runTo(w, t, HASH_EVERY + 1);
    for (const s of sybils) w.onHash(s.conn, HASH_EVERY, BAD);
    for (const h of honest) w.onHash(h.conn, HASH_EVERY, GOOD);
    t.ms += 3000;
    w.tick();
    for (const h of honest) expect(w.members.get(h.conn)!.live, "an honest painter was resynced").toBe(true);
    for (const s of sybils) expect(w.members.get(s.conn)!.live).toBe(false);
  });
});

describe("M1: old-tick HASH frames leave the server's maps bounded", () => {
  it("a spray of hashes for every old checkpoint opens at most the window's worth", () => {
    const { w, t } = world("sandbox");
    const a = joinAs(w, { ipTag: "aaaaaa" });
    joinAs(w, { ipTag: "bbbbbb" }); // a second member who never reports, so checkpoints stay open
    // An hour's worth of checkpoints, with the attacker's minHashTick at 0 (as if it joined at the start).
    const end = 60 * 60 * HASH_EVERY;
    runTo(w, t, end);
    w.members.get(a.conn)!.minHashTick = 0;
    for (let tick = HASH_EVERY; tick <= end; tick += HASH_EVERY) w.onHash(a.conn, tick, BAD);
    const window = HASH_WINDOW_TICKS / HASH_EVERY + 1;
    expect(w.hashState().checkpoints, "open checkpoints").toBeLessThanOrEqual(window);
    t.ms += 3000;
    w.tick();
    expect(w.hashState().truth, "kept majority hashes").toBeLessThanOrEqual(window);
  });
});

describe("M2: the catch-up burst does not trip the live send-queue cap", () => {
  it("a joiner whose catch-up is larger than MAX_BUFFERED_BYTES is not closed as too slow, and the cap returns once it drains", () => {
    const { w, t } = world("sandbox");
    joinAs(w, { ipTag: "aaaaaa" }); // keeps the world live and ticking
    // About 9.5 MiB of log: full ticks of Paint inputs (no snapshot, as when verification keeps failing).
    const paint = { player: 1, kind: 5, payload: new Uint8Array(10) };
    for (let k = 0; k < 140; k++) {
      for (let i = 0; i < 4000; i++) w.stampClient(paint);
      t.ms += 1000 / 60;
      for (const id of w.members.keys()) w.heard(id);
      w.tick();
    }
    // A socket that has not drained at all by the end of the burst (one synchronous loop: measured, M2 in the report).
    let queued = 0;
    const p = fakePeer();
    p.send = (f) => {
      queued += f.length;
      p.sent.push(f);
    };
    p.buffered = () => queued;
    w.join(p, { ipTag: "bbbbbb" });
    expect(queued, "the burst is over the live cap").toBeGreaterThan(8 * 1024 * 1024);
    expect(p.closed, "closed partway through its own catch-up").toBeNull();
    // Once its queue drains under the cap, the live cap applies again: a socket that then backs up is dropped.
    queued = 0;
    t.ms += 1000 / 60;
    w.tick();
    queued = 9 * 1024 * 1024;
    t.ms += 1000 / 60;
    w.tick();
    expect(p.closed).toBe("too slow");
  });
});
