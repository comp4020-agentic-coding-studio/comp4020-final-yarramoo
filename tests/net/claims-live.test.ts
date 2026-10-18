// M6 slice b end to end: two real sim clients in the game world, one kills the other with bombs, the server
// tallies the CLAIMs and awards first_blood (D-120). Recipe from D-114: teleport onto a deep Bomb pickup, then cast.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { ENT_PICKUP, EV_DEATH, loadSim } from "../../shared/sim.ts";
import { encodeClaim } from "../../shared/protocol.ts";
import { buildHashHex, connect, register, sleep, wasmBytes, waitFor, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function boot(): Promise<RunningServer> {
  const d = mkdtempSync(join(tmpdir(), "sand-claim-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: d, quiet: true, inputSummaryMs: 100000 });
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;
const BOMB = 5;

/** A deep Bomb pickup, in cells (pickups are a pure function of the seed, D-052). */
function bombPickup(): { x: number; y: number } {
  const sim = loadSim(wasmBytes);
  sim.init(20261014n, 1);
  const p = sim.entities().filter((e) => e.type === ENT_PICKUP && e.sub === BOMB).sort((a, b) => a.id - b.id)[0];
  return { x: p.x / 16, y: p.y / 16 };
}
const deaths = (c: TestClient) => {
  const out: { victim: number; killer: number; cause: number }[] = [];
  void c;
  return out;
};
void deaths;

describe("logging resolved deaths", () => {
  it("a bomb that kills three players in one tick logs all three deaths", async () => {
    // A global rate limit on claim.death once dropped all but the first of these. Each real death resolves
    // exactly once, so every one must reach the log (the crit 10 log is how deaths are read).
    const s = await boot();
    const ids = [await register(s.port, "A"), await register(s.port, "B"), await register(s.port, "C"), await register(s.port, "D")].map((r) => r.id);
    const [killer, ...victims] = ids;
    for (const v of victims) s.game.onDeathResolved!({ tick: 500, victim: v, killer, cause: BOMB, bag: 1 });
    const logged = s.log.recent().filter((e) => e.ev === "claim.death");
    expect(logged).toHaveLength(3);
    expect(logged.map((e) => e.victim)).toEqual(victims.map((v) => `${["B", "C", "D"][victims.indexOf(v)]}#${v}`));
  });
});

describe("two real clients, one kills the other", () => {
  it("the killer is awarded first_blood, deaths and kills are counted, claim.death is logged", async () => {
    const s = await boot();
    const ana = await register(s.port, "Ana");
    const bo = await register(s.port, "Bo");
    const a = await connect(s.port, hex, { world: GAME, token: ana.token });
    const b = await connect(s.port, hex, { world: GAME, token: bo.token });
    const at = bombPickup();
    a.move(at.x, at.y);
    b.move(at.x + 12, at.y); // far enough that Ana's own blast never reaches her
    await sleep(500);
    let seq = 1;
    let sawDeath = false;
    for (let i = 0; i < 12 && !sawDeath; i++) {
      a.cast(BOMB, 0, seq++); // angle 0: along +x, at Bo
      await sleep(700);
      sawDeath = s.log.recent().some((e) => e.ev === "claim.death");
    }
    await waitFor(() => s.log.recent().some((e) => e.ev === "claim.death"), 5000, "claim.death");
    const ev = s.log.recent().filter((e) => e.ev === "claim.death");
    expect(ev[0]).toMatchObject({ victim: `Bo#${bo.id}`, killer: `Ana#${ana.id}` });
    await waitFor(() => a.achievements.some((x) => x.id === "first_blood"), 3000, "first_blood");
    expect(s.playerStats.get(bo.id).deaths).toBe(1);
    expect(s.playerStats.get(ana.id).kills).toBe(1);
    expect(s.db!.achievementsOf(ana.id)).toContain("first_blood");
    expect(b.achievements.map((x) => x.id)).not.toContain("first_blood");
    // Both clients claimed the same death; it counted once.
    expect(ev).toHaveLength(1);
    a.close();
    b.close();
  }, 60000);

  it("a registered spectator's claim counts as a witness, an anonymous one does not, and a sandbox claim is refused", async () => {
    const s = await boot();
    const ana = await register(s.port, "Ana");
    const g = await connect(s.port, hex, { world: GAME, token: ana.token });
    const watcher = await register(s.port, "Watcher");
    const spec = await connect(s.port, hex, { world: GAME, spectate: true, token: watcher.token });
    const anon = await connect(s.port, hex, { world: GAME, spectate: true });
    await sleep(300);
    g.claims = false;
    const tick = s.game.clock.lastClosed - 1;
    // An anonymous socket neither votes nor counts.
    anon.ws.send(encodeClaim(tick, ana.id, 0, 7, 0));
    await sleep(200);
    expect(s.playerStats.get(ana.id).deaths ?? 0).toBe(0);
    // Two registered visitors (need 1 of 2): the registered spectator alone resolves it.
    spec.ws.send(encodeClaim(tick, ana.id, 0, 7, 0));
    await waitFor(() => s.playerStats.get(ana.id).deaths === 1, 3000, "spectator claim counted");
    const sb = await connect(s.port, hex, { world: 0 });
    await sleep(100);
    sb.ws.send(encodeClaim(s.world.clock.lastClosed - 1, 1, 0, 7, 0));
    await sleep(200);
    expect(s.log.recent().filter((e) => e.ev === "input.rejected" && e.reason === "claim_in_sandbox")).toHaveLength(1);
    expect(s.log.recent().filter((e) => e.ev === "claim.death")).toHaveLength(1);
    void EV_DEATH;
    g.close();
    spec.close();
    anon.close();
    sb.close();
  }, 30000);
});
