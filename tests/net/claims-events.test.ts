// F7 item 2: generalised claims (enemy kill, round start, round end) on a bare World with a fake clock.
import { describe, expect, it } from "vitest";
import { Achievements } from "../../server/achievements.ts";
import { EventLog } from "../../server/log.ts";
import { PlayerStats } from "../../server/stats.ts";
import { GameDb } from "../../server/db.ts";
import { RoomsStore } from "../../server/rooms.ts";
import { World, type Peer, type ResolvedKill, type ResolvedRoundEnd, type ResolvedRoundStart } from "../../server/world.ts";
import { decodeClient, encodeClaimEvent, CLAIM_KILL, CLAIM_ROUND_END } from "../../shared/protocol.ts";
import { SURVIVAL, encodeConfig } from "../../shared/room.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const peer = (): Peer => ({ send() {}, buffered: () => 0, close() {} });
function rig(n: number) {
  let t = 1000;
  const log = new EventLog({ quiet: true });
  const w = new World({ id: 777, cfg: { ...SURVIVAL, size: 0 }, now: () => t, log });
  const kills: ResolvedKill[] = [];
  const starts: ResolvedRoundStart[] = [];
  const ends: ResolvedRoundEnd[] = [];
  w.onKillResolved = (k) => kills.push(k);
  w.onRoundStartResolved = (r) => starts.push(r);
  w.onRoundEndResolved = (r) => ends.push(r);
  const conns: number[] = [];
  for (let i = 1; i <= n; i++) {
    const c = w.join(peer(), { playerId: i, name: `P${i}`, visitorId: i, visitorName: `P${i}` }).conn;
    w.onLive(c, w.clock.lastClosed);
    conns.push(c);
  }
  t += 2000;
  w.tick();
  return { w, kills, starts, ends, conns, tick: () => w.clock.lastClosed - 3 };
}
const kill = (tick: number, killer = 1): ResolvedKill => ({ tick, killer, x: 800, y: 900, kind: 1 });

describe("wire format", () => {
  it("round-trips a claim event with ids, and refuses a truncated one", () => {
    const f = encodeClaimEvent(CLAIM_ROUND_END, 99, 1, 3, 0, 0, [1, 2]);
    expect(decodeClient(f)).toEqual({ t: "claim-event", kind: CLAIM_ROUND_END, tick: 99, a: 1, b: 3, c: 0, d: 0, ids: [1, 2] });
    expect(decodeClient(f.slice(0, f.length - 1))).toBeNull();
  });
});

describe("enemy kill claims", () => {
  it("one client alone cannot resolve a kill in a 3-player room; two can; a third vote changes nothing", () => {
    const r = rig(3);
    const k = kill(r.tick());
    r.w.onKillClaim(r.conns[0], k);
    expect(r.kills).toEqual([]);
    r.w.onKillClaim(r.conns[0], k);
    expect(r.kills).toEqual([]);
    r.w.onKillClaim(r.conns[1], k);
    expect(r.kills).toEqual([k]);
    r.w.onKillClaim(r.conns[2], k);
    expect(r.kills).toHaveLength(1);
  });
  it("a forged killer id is credited to nobody", () => {
    const r = rig(1);
    r.w.onKillClaim(r.conns[0], kill(r.tick(), 999));
    expect(r.kills[0].killer).toBe(0);
  });
});

describe("round start and end claims", () => {
  it("round start marks the room running once a majority agrees", () => {
    const r = rig(2);
    r.w.onRoundStartClaim(r.conns[0], { tick: r.tick(), active: 2 });
    expect(r.w.roundRunning).toBe(true); // 1 of 2 is a majority
    expect(r.starts).toHaveLength(1);
  });
  it("a lone liar in a 3-player room cannot end the round or fake a win", () => {
    const r = rig(3);
    r.w.onRoundEndClaim(r.conns[2], { tick: r.tick(), win: true, players: 3, alive: [3] });
    expect(r.ends).toEqual([]);
    expect(r.w.roundEnded).toBe(false);
  });
  it("the alive set is part of the claim: disagreeing sets do not resolve together", () => {
    const r = rig(3);
    const t = r.tick();
    r.w.onRoundEndClaim(r.conns[0], { tick: t, win: true, players: 3, alive: [1, 2] });
    r.w.onRoundEndClaim(r.conns[1], { tick: t, win: true, players: 3, alive: [1] });
    expect(r.ends).toEqual([]);
    r.w.onRoundEndClaim(r.conns[2], { tick: t, win: true, players: 3, alive: [1, 2] });
    expect(r.ends).toEqual([{ tick: t, win: true, players: 3, alive: [1, 2] }]);
    expect(r.w.roundEnded).toBe(true);
  });
  it("refuses a win with nobody alive and an alive id the room never saw", () => {
    const r = rig(1);
    r.w.onRoundEndClaim(r.conns[0], { tick: r.tick(), win: true, players: 1, alive: [] });
    r.w.onRoundEndClaim(r.conns[0], { tick: r.tick(), win: true, players: 1, alive: [42] });
    expect(r.ends).toEqual([]);
  });
  it("a loss may have nobody alive", () => {
    const r = rig(1);
    r.w.onRoundEndClaim(r.conns[0], { tick: r.tick(), win: false, players: 1, alive: [] });
    expect(r.ends).toHaveLength(1);
  });
});

describe("achievements from claims", () => {
  const mk = () => {
    const got: string[] = [];
    const a = new Achievements(null, new PlayerStats(null), new EventLog({ quiet: true }), (v, id) => got.push(`${v}:${id}`));
    return { a, got };
  };
  const ctx = (id: number) => ({ name: `P${id}`, world: 1, tick: 5 });
  it("first kill is Slime slayer; the 50th is Exterminator; boss kills count separately", () => {
    const { a, got } = mk();
    a.onEnemyKill(1, 1, ctx(1));
    expect(got).toEqual(["1:slime_slayer"]);
    for (let i = 0; i < 48; i++) a.onEnemyKill(1, 1, ctx(1));
    expect(got).not.toContain("1:exterminator");
    a.onEnemyKill(1, 4, ctx(1));
    expect(got).toContain("1:exterminator");
  });
  it("a won party of 3 with 2 alive: both get Deep Mage slain, neither Last one standing or Solo", () => {
    const { a, got } = mk();
    a.onRoundWon([1, 2], 3, ctx);
    expect(got.sort()).toEqual(["1:deep_mage_slain", "2:deep_mage_slain"]);
  });
  it("one survivor of a larger party is Last one standing; a party of one is Solo descent", () => {
    const x = mk();
    x.a.onRoundWon([2], 3, ctx);
    expect(x.got.sort()).toEqual(["2:deep_mage_slain", "2:last_one_standing"]);
    const y = mk();
    y.a.onRoundWon([1], 1, ctx);
    expect(y.got.sort()).toEqual(["1:deep_mage_slain", "1:solo_descent"]);
  });
});

describe("an ended room", () => {
  it("leaves the public list and stays out after a restart (persisted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sand-ended-"));
    try {
      const db = new GameDb(dir);
      const rooms = new RoomsStore(db);
      const mkRoom = (name: string) => {
        const r = rooms.createRoom({ name, mode: "survival", config: encodeConfig(SURVIVAL), visibility: "public", creatorPlayerId: null });
        if (!r.ok) throw new Error(r.reason);
        return r.room;
      };
      const a = mkRoom("A");
      const b = mkRoom("B");
      expect(rooms.listPublicRooms().map((x) => x.name).sort()).toEqual(["A", "B"]);
      rooms.markEnded(a.id);
      expect(rooms.listPublicRooms().map((x) => x.name)).toEqual(["B"]);
      expect(rooms.getRoomByCode(a.code)!.endedAt).not.toBeNull();
      expect(rooms.getRoomById(b.id)!.endedAt).toBeNull();
      db.close();
      const again = new RoomsStore(new GameDb(dir));
      expect(again.listPublicRooms().map((x) => x.name)).toEqual(["B"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
void CLAIM_KILL;
