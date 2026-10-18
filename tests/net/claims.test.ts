// M6 slice b: the majority death claim (plan 10, D-120/D-121), on a bare World with a fake clock and fake peers.
import { describe, expect, it } from "vitest";
import { Achievements } from "../../server/achievements.ts";
import { EventLog } from "../../server/log.ts";
import { PlayerStats } from "../../server/stats.ts";
import { CLAIMS_PER_WINDOW, CLAIM_WINDOW_MS, GAME_ID, MAX_OPEN_CLAIMS, SANDBOX_ID, World, type Peer, type ResolvedDeath } from "../../server/world.ts";

const peer = (): Peer => ({ send() {}, buffered: () => 0, close() {} });

function rig(world = GAME_ID) {
  let t = 1000;
  const log = new EventLog({ quiet: true });
  const w = new World({ id: world, now: () => t, log });
  const resolved: ResolvedDeath[] = [];
  w.onDeathResolved = (d) => resolved.push(d);
  // These members are already caught up: say so, or the world's clock is held (D-122) and no tick closes.
  const add = (pid: number) => {
    const conn = w.join(peer(), { playerId: pid, name: `P${pid}`, visitorId: pid, visitorName: `P${pid}` }).conn;
    w.onLive(conn, w.clock.lastClosed); // its replay target, which is its minHashTick
    return conn;
  };
  const advance = (ms: number) => {
    t += ms;
    w.tick();
  };
  return { w, log, resolved, add, advance, setNow: (v: number) => (t = v) };
}
const death = (tick: number, victim = 1, killer = 2, cause = 5, bag = 0): ResolvedDeath => ({ tick, victim, killer, cause, bag });

describe("majority claim", () => {
  it("with 3 eligible clients, 1 claim does not award and a 2nd identical one does", () => {
    const r = rig();
    const [a, b] = [r.add(1), r.add(2)];
    r.add(3);
    r.advance(2000); // 120 ticks
    const tick = r.w.clock.lastClosed - 5;
    r.w.onClaim(a, death(tick));
    expect(r.resolved).toEqual([]);
    r.w.onClaim(b, death(tick));
    expect(r.resolved).toEqual([{ tick, victim: 1, killer: 2, cause: 5, bag: 0 }]);
  });

  it("with 1 client, its single claim is accepted", () => {
    const r = rig();
    const a = r.add(1);
    r.advance(1000);
    r.w.onClaim(a, death(r.w.clock.lastClosed - 1));
    expect(r.resolved).toHaveLength(1);
  });

  it("2 of 3 agreeing beats a conflicting third, whichever order they arrive in", () => {
    const r = rig();
    const [a, b, c] = [r.add(1), r.add(2), r.add(3)];
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    r.w.onClaim(c, death(tick, 1, 3)); // the liar speaks first: 1 vote, need 2
    r.w.onClaim(a, death(tick, 1, 2));
    expect(r.resolved).toEqual([]);
    r.w.onClaim(b, death(tick, 1, 2));
    expect(r.resolved.map((d) => d.killer)).toEqual([2]);
    // The dissent after the fact is logged, not counted.
    const n = r.resolved.length;
    r.w.onClaim(c, death(tick, 1, 3));
    expect(r.resolved).toHaveLength(n);
  });

  it("with 4 eligible (need 2), a rival group that reaches 2 first wins and the lone dissenter does not", () => {
    const r = rig();
    const [p, q, , x] = [r.add(1), r.add(2), r.add(3), r.add(4)];
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    r.w.onClaim(p, death(tick, 1, 2));
    r.w.onClaim(q, death(tick, 1, 3));
    expect(r.resolved).toEqual([]);
    r.w.onClaim(x, death(tick, 1, 3));
    expect(r.resolved.map((d) => d.killer)).toEqual([3]);
  });

  it("a 1-1 tie of conflicting claims at need 1 is not resolved by the first arrival", () => {
    const r = rig();
    const [p, q] = [r.add(1), r.add(2)]; // need ceil(2/2) = 1
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    r.w.onClaim(p, death(tick, 1, 2));
    // p alone reaches the quorum of 1 with no rival yet: it resolves (D-121 records this two-client weakness).
    expect(r.resolved).toHaveLength(1);
    r.w.onClaim(q, death(tick, 1, 9));
    expect(r.resolved).toHaveLength(1);
    expect(r.log.recent().filter((e) => e.ev === "claim.unresolved" && e.reason === "dissent")).toHaveLength(1);
  });

  it("an unresolved claim is dropped after 10 s and logged", () => {
    const r = rig();
    const a = r.add(1);
    r.add(2);
    r.add(3);
    r.advance(1000);
    r.w.onClaim(a, death(r.w.clock.lastClosed - 1));
    r.advance(CLAIM_WINDOW_MS + 500);
    const ev = r.log.recent().filter((e) => e.ev === "claim.unresolved");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ votes: 1, eligible: 3 });
    expect(r.resolved).toEqual([]);
  });

  it("a client that was not past its replay target at that tick does not count, and is not eligible", () => {
    const r = rig();
    const a = r.add(1);
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    const late = r.add(2); // joins after `tick`: its minHashTick is beyond it
    r.advance(100);
    // Its claim for an earlier tick is refused outright...
    r.w.onClaim(late, death(tick));
    expect(r.resolved).toEqual([]);
    // ...and it does not raise the quorum for that tick: one eligible voter (a) is enough.
    r.w.onClaim(a, death(tick));
    expect(r.resolved).toHaveLength(1);
  });

  it("a claim from a connection that has left does not count", () => {
    const r = rig();
    const a = r.add(1);
    r.add(2);
    r.add(3);
    r.advance(1000);
    const tick = r.w.clock.lastClosed - 1;
    r.w.onClaim(a, death(tick));
    r.w.leave(a);
    r.advance(100);
    expect(r.resolved).toEqual([]);
  });

  it("the sandbox world takes no claims", () => {
    const r = rig(SANDBOX_ID);
    const a = r.add(1);
    r.advance(1000);
    r.w.onClaim(a, death(r.w.clock.lastClosed - 1));
    expect(r.resolved).toEqual([]);
  });
});

describe("claim abuse", () => {
  it("one connection sending the same claim 100 times counts once", () => {
    const r = rig();
    const a = r.add(1);
    r.add(2);
    r.add(3);
    r.advance(1000);
    const tick = r.w.clock.lastClosed - 1;
    for (let i = 0; i < 100; i++) r.w.onClaim(a, death(tick));
    expect(r.resolved).toEqual([]);
  });

  it("a claim for a tick that has not closed, or is older than 10 s, is ignored", () => {
    const r = rig();
    const a = r.add(1);
    r.advance(20_000);
    const last = r.w.clock.lastClosed;
    r.w.onClaim(a, death(last + 1));
    r.w.onClaim(a, death(last + 100000));
    r.w.onClaim(a, death(last - 601));
    expect(r.resolved).toEqual([]);
    r.w.onClaim(a, death(last - 600));
    expect(r.resolved).toHaveLength(1);
  });

  it("a flood of distinct fake deaths is rate limited per connection", () => {
    const r = rig();
    const a = r.add(1);
    r.advance(2000);
    const last = r.w.clock.lastClosed;
    for (let i = 0; i < 500; i++) r.w.onClaim(a, death(last - 1 - (i % 100), 1, 2, 5, i % 7));
    expect(r.resolved).toHaveLength(CLAIMS_PER_WINDOW);
    expect(r.log.recent().filter((e) => e.ev === "input.rate_limited")).toHaveLength(1);
  });

  it("open tallies are capped and the oldest is evicted", () => {
    const r = rig();
    const a = r.add(1);
    r.add(2);
    r.add(3);
    r.advance(2000);
    const last = r.w.clock.lastClosed;
    // Refill the rate window between batches so only the cap is under test.
    for (let i = 0; i < MAX_OPEN_CLAIMS + 20; i++) {
      if (i % CLAIMS_PER_WINDOW === 0) r.advance(10_000);
      r.w.onClaim(a, death(r.w.clock.lastClosed - 1, 1, 2, i % 256, Math.floor(i / 256)));
    }
    void last;
    // The oldest victim's tally is gone: two more votes for it can no longer resolve it.
    const m2 = [...r.w.members.keys()][1];
    r.w.onClaim(m2, death(r.w.clock.lastClosed - 1, 1, 2, 0, 0));
    expect(r.resolved).toEqual([]);
  });
});

describe("kills, deaths and the four claim achievements", () => {
  function harness() {
    const stats = new PlayerStats(null);
    const given: string[] = [];
    const ach = new Achievements(null, stats, new EventLog({ quiet: true }), (v, id) => given.push(`${v}:${id}`));
    const ctx = (v: number) => ({ name: `P${v}`, world: 1, tick: 7 });
    return { stats, given, die: (victim: number, killer: number, cause = 5) => ach.onDeath(victim, killer, cause, ctx) };
  }
  it("first_blood at exactly 1 kill; five_kills at exactly 5; kills and deaths counted", () => {
    const h = harness();
    for (let i = 1; i <= 4; i++) {
      h.die(9, 1);
      expect(h.stats.get(1).kills).toBe(i);
      expect(h.given.filter((g) => g.startsWith("1:"))).toEqual(["1:first_blood"]);
    }
    expect(h.given).not.toContain("1:five_kills");
    h.die(9, 1);
    expect(h.given.filter((g) => g.startsWith("1:"))).toEqual(["1:first_blood", "1:five_kills"]);
    expect(h.stats.get(9).deaths).toBe(5);
  });
  it("back_from_the_dead at exactly 10 deaths, with no killer needed", () => {
    const h = harness();
    for (let i = 0; i < 9; i++) h.die(3, 0, 7);
    expect(h.given).toEqual([]);
    h.die(3, 0, 7);
    expect(h.given).toEqual(["3:back_from_the_dead"]);
    expect(h.stats.get(3).kills).toBeUndefined();
  });
  it("a self-kill counts a death and no kill", () => {
    const h = harness();
    h.die(4, 4, 5);
    expect(h.stats.get(4)).toEqual({ deaths: 1 });
    expect(h.given).toEqual([]);
  });
  it("shoved_to_doom only for a credited kill that died to fire (6), lava (7) or gunpowder (8)", () => {
    for (const cause of [0, 1, 2, 3, 4, 5, 9]) {
      const h = harness();
      h.die(9, 1, cause);
      expect(h.given).toEqual(["1:first_blood"]);
    }
    for (const cause of [6, 7, 8]) {
      const h = harness();
      h.die(9, 1, cause);
      expect(h.given).toEqual(["1:first_blood", "1:shoved_to_doom"]);
    }
    const h = harness();
    h.die(9, 0, 7); // lava with no credited hitter
    expect(h.given).toEqual([]);
  });
});

describe("anonymous and unregistered voters (review S1)", () => {
  const anon = (r: ReturnType<typeof rig>) => r.w.join(peer(), { spectate: true }).conn;
  it("5 anonymous spectators plus 1 honest player: their claims never resolve a death or raise the quorum", () => {
    const r = rig();
    const honest = r.add(1);
    const spies = [anon(r), anon(r), anon(r), anon(r), anon(r)];
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    for (const s of spies) r.w.onClaim(s, death(tick, 1, 0));
    expect(r.resolved).toEqual([]);
    // The honest player alone is the whole electorate (quorum 1), unmoved by five sockets.
    r.w.onClaim(honest, death(tick, 1, 0));
    expect(r.resolved).toEqual([{ tick, victim: 1, killer: 0, cause: 5, bag: 0 }]);
  });
  it("one visitor on two connections votes once and is one eligible voter", () => {
    const r = rig();
    const tab1 = r.w.join(peer(), { playerId: 1, name: "A", visitorId: 1, visitorName: "A" }).conn;
    const spec = r.w.join(peer(), { spectate: true, visitorId: 1, visitorName: "A" }).conn;
    const b = r.add(2);
    r.add(3);
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    r.w.onClaim(tab1, death(tick, 2, 0));
    r.w.onClaim(spec, death(tick, 2, 0));
    expect(r.resolved).toEqual([]); // 3 visitors, need 2, only visitor 1 has voted
    r.w.onClaim(b, death(tick, 2, 0));
    expect(r.resolved).toHaveLength(1);
  });
  it("a registered spectator still counts as a witness", () => {
    const r = rig();
    r.add(1);
    const spec = r.w.join(peer(), { spectate: true, visitorId: 7, visitorName: "S" }).conn;
    r.advance(2000);
    r.w.onClaim(spec, death(r.w.clock.lastClosed - 5, 1, 0));
    expect(r.resolved).toHaveLength(1);
  });
});

describe("ids the world has not seen (review N1)", () => {
  it("a quorum of real voters naming unknown or offline ids bumps no stats and grants nothing for them", () => {
    const stats = new PlayerStats(null);
    const given: string[] = [];
    const ach = new Achievements(null, stats, new EventLog({ quiet: true }), (v, id) => given.push(`${v}:${id}`));
    const r = rig();
    r.w.onDeathResolved = (d) => ach.onDeath(d.victim, d.killer, d.cause, (v) => ({ name: `P${v}`, world: 1, tick: d.tick }));
    const [a, b] = [r.add(1), r.add(2)];
    r.advance(2000);
    const tick = r.w.clock.lastClosed - 5;
    for (const c of [a, b]) {
      r.w.onClaim(c, death(tick, 999, 1)); // unknown victim: refused
      r.w.onClaim(c, death(tick + 1, 1, 888)); // unknown killer: counted as no killer
    }
    expect(stats.get(999)).toEqual({});
    expect(stats.get(888)).toEqual({});
    expect(stats.get(1)).toEqual({ deaths: 1 });
    expect(given).toEqual([]);
  });
  it("a player who joined and left can still be a victim, and a never-seen id cannot", () => {
    const r = rig();
    const a = r.add(1);
    const gone = r.add(5);
    r.w.leave(gone);
    r.advance(2000);
    r.w.onClaim(a, death(r.w.clock.lastClosed - 5, 5, 1));
    expect(r.resolved).toEqual([{ tick: r.w.clock.lastClosed - 5, victim: 5, killer: 1, cause: 5, bag: 0 }]);
    r.w.onClaim(a, death(r.w.clock.lastClosed - 4, 6, 1));
    expect(r.resolved).toHaveLength(1);
  });
});
