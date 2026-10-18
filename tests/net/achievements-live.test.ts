// M6 slice a: evaluation, delivery and persistence of server-countable achievements over the real protocol.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { MAX_ACHIEVEMENT_ID_BYTES, PROTOCOL_VERSION, S_ACHIEVEMENT, decodeServer, encodeAchievement } from "../../shared/protocol.ts";
import { buildHashHex, connect, register, sleep, waitFor, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-achl-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string | null): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, inputSummaryMs: 100000 });
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;
const WATER = 2;
const ROSE = 3;
const BOMB = 5;

/** Send `n` casts under the server's 40 inputs/s limit. */
async function castMany(c: TestClient, spell: number, n: number, seq0 = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    c.cast(spell, 100, seq0 + i);
    if (i % 10 === 9) await sleep(400);
  }
  await sleep(300);
}
const ids = (c: TestClient) => c.achievements.map((a) => a.id);

describe("awarding", () => {
  it("first_spell on the first cast, with the tick, logged as name#id and nothing else", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Ana");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    await sleep(100);
    expect(ids(g)).toEqual([]);
    g.cast(0, 100, 1);
    await waitFor(() => g.achievements.length === 1, 3000, "first_spell");
    expect(ids(g)).toEqual(["first_spell"]);
    expect(g.achievements[0].tick).toBeGreaterThan(0);
    const ev = s.log.recent().filter((e) => e.ev === "achievement.awarded");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ who: `Ana#${me.id}`, achievement: "first_spell", world: GAME });
    expect(s.db!.achievementsOf(me.id)).toEqual(["first_spell"]);
    g.close();
  });

  it("waterworks at exactly 100 Water casts: 99 give nothing beyond first_spell", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Wet");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    await castMany(g, WATER, 99);
    expect(s.playerStats.get(me.id).casts_water).toBe(99);
    expect(ids(g)).toEqual(["first_spell"]);
    g.cast(WATER, 100, 100);
    await waitFor(() => g.achievements.length === 2, 3000, "waterworks");
    expect(ids(g)).toEqual(["first_spell", "waterworks"]);
    // Casting past the threshold does not award or send again.
    await castMany(g, WATER, 20, 101);
    expect(ids(g)).toEqual(["first_spell", "waterworks"]);
    expect(s.log.recent().filter((e) => e.ev === "achievement.awarded")).toHaveLength(2);
    g.close();
  }, 30000);

  it("gardener at 100 Rose casts, demolitionist at 25 Bomb casts", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Mix");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    await castMany(g, BOMB, 24);
    expect(ids(g)).toEqual(["first_spell"]);
    g.cast(BOMB, 100, 25);
    await waitFor(() => ids(g).includes("demolitionist"), 3000, "demolitionist");
    await castMany(g, ROSE, 99, 26);
    expect(ids(g)).toEqual(["first_spell", "demolitionist"]);
    g.cast(ROSE, 100, 125);
    await waitFor(() => ids(g).includes("gardener"), 3000, "gardener");
    g.close();
  }, 30000);

  it("pyromaniac at exactly 50 Fire bolt casts", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Fire");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    await castMany(g, 4, 49);
    expect(ids(g)).toEqual(["first_spell"]);
    g.cast(4, 100, 50);
    await waitFor(() => ids(g).includes("pyromaniac"), 3000, "pyromaniac");
    g.close();
  }, 30000);

  it("spelunker at y = 800 cells and not at 799", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Deep");
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 799);
    await sleep(200);
    expect(ids(g)).toEqual([]);
    g.move(100, 800);
    await waitFor(() => ids(g).includes("spelunker"), 3000, "spelunker");
    expect(ids(g)).toEqual(["spelunker"]);
    g.close();
  });

  it("anonymous visitors earn nothing", async () => {
    const s = await boot(tmp());
    const c = await connect(s.port, hex, { world: 0 });
    const spec = await connect(s.port, hex, { world: GAME, spectate: true });
    c.paint(4, 100, 50, 140, 50, 6);
    await sleep(200);
    expect(c.achievements).toEqual([]);
    s.achievements.onStat(0, "casts_push", { name: "", world: GAME, tick: 1 });
    expect(s.log.recent().filter((e) => e.ev === "achievement.awarded")).toEqual([]);
    expect(s.db!.db.prepare("select count(*) as n from achievements").get()).toEqual({ n: 0 });
    c.close();
    spec.close();
  });
});

describe("who is told", () => {
  it("only the earner receives S_ACHIEVEMENT", async () => {
    const s = await boot(tmp());
    const a = await register(s.port, "Earner");
    const b = await register(s.port, "Bystander");
    const ga = await connect(s.port, hex, { world: GAME, token: a.token });
    const gb = await connect(s.port, hex, { world: GAME, token: b.token });
    ga.move(100, 100);
    gb.move(200, 100);
    ga.cast(0, 100, 1);
    await waitFor(() => ga.achievements.length === 1, 3000, "earner told");
    await sleep(300);
    expect(ids(ga)).toEqual(["first_spell"]);
    expect(gb.achievements).toEqual([]);
    expect(s.db!.achievementsOf(b.id)).toEqual([]);
    ga.close();
    gb.close();
  });

  it("once per visitor across reconnects and both worlds: no second award, no second toast", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Once");
    const g1 = await connect(s.port, hex, { world: GAME, token: me.token });
    g1.move(100, 100);
    g1.cast(0, 100, 1);
    await waitFor(() => g1.achievements.length === 1, 3000, "first");
    g1.close();
    await sleep(200);
    const g2 = await connect(s.port, hex, { world: GAME, token: me.token });
    g2.move(100, 100);
    g2.cast(0, 100, 1);
    await sleep(400);
    expect(g2.achievements).toEqual([]);
    // The sandbox identity is the same visitor; painting there earns nothing and awards nothing again.
    const sb = await connect(s.port, hex, { world: 0, token: me.token });
    sb.paint(4, 100, 50, 140, 50, 6);
    await sleep(300);
    expect(sb.achievements).toEqual([]);
    expect(s.log.recent().filter((e) => e.ev === "achievement.awarded")).toHaveLength(1);
    g2.close();
    sb.close();
  });

  it("two open tabs of one visitor in different worlds are both told", async () => {
    const s = await boot(tmp());
    const me = await register(s.port, "Both");
    const sb = await connect(s.port, hex, { world: 0, token: me.token });
    const g = await connect(s.port, hex, { world: GAME, token: me.token });
    g.move(100, 100);
    g.cast(0, 100, 1);
    await waitFor(() => g.achievements.length === 1 && sb.achievements.length === 1, 3000, "both tabs");
    g.close();
    sb.close();
  });
});

describe("persistence", () => {
  it("an award survives a restart on the same DATA_DIR and is not toasted again", async () => {
    const dir = tmp();
    const s1 = await boot(dir);
    const me = await register(s1.port, "Keeper");
    const g1 = await connect(s1.port, hex, { world: GAME, token: me.token });
    g1.move(100, 100);
    g1.cast(0, 100, 1);
    await waitFor(() => g1.achievements.length === 1, 3000, "first");
    g1.close();
    await sleep(200);
    await s1.close();
    const s2 = await boot(dir);
    expect(s2.db!.achievementsOf(me.id)).toEqual(["first_spell"]);
    const g2 = await connect(s2.port, hex, { world: GAME, token: me.token });
    g2.move(100, 100);
    g2.cast(0, 100, 1);
    await sleep(400);
    expect(g2.achievements).toEqual([]);
    expect(s2.log.recent().filter((e) => e.ev === "achievement.awarded")).toEqual([]);
    g2.close();
  });
});

describe("S_ACHIEVEMENT frame", () => {
  it("round trips and has a literal layout", () => {
    expect(PROTOCOL_VERSION).toBe(8);
    const f = encodeAchievement("waterworks", 0x01020304);
    expect(Array.from(f)).toEqual([S_ACHIEVEMENT, 10, ...Buffer.from("waterworks"), 4, 3, 2, 1]);
    expect(decodeServer(f)).toEqual({ t: "achievement", id: "waterworks", tick: 0x01020304 });
  });
  it("refuses to encode an empty or oversized id", () => {
    expect(() => encodeAchievement("", 1)).toThrow();
    expect(() => encodeAchievement("x".repeat(MAX_ACHIEVEMENT_ID_BYTES + 1), 1)).toThrow();
    expect(decodeServer(encodeAchievement("x".repeat(MAX_ACHIEVEMENT_ID_BYTES), 1))).toMatchObject({ t: "achievement" });
  });
  it("decodes hostile bytes to null without throwing", () => {
    const good = Array.from(encodeAchievement("gardener", 7));
    const bad: number[][] = [
      [S_ACHIEVEMENT],
      [S_ACHIEVEMENT, 0, 0, 0, 0, 0],
      [S_ACHIEVEMENT, 255, ...new Array(300).fill(65)],
      [S_ACHIEVEMENT, MAX_ACHIEVEMENT_ID_BYTES + 1, ...new Array(MAX_ACHIEVEMENT_ID_BYTES + 5).fill(65)],
      good.slice(0, -1), // truncated tick
      [...good, 0], // trailing byte
      [S_ACHIEVEMENT, 2, 0xff, 0xfe, 0, 0, 0, 0], // invalid UTF-8
      [S_ACHIEVEMENT, 9, 65, 0, 0, 0, 0], // length prefix longer than the frame
    ];
    for (const b of bad) expect(decodeServer(new Uint8Array(b))).toBeNull();
  });
});
