// D-122: the world's clock is held while every member is still catching up, and runs as soon as any member is live.
// Real server, real WebSocket clients. A `manual` client receives ticks but never steps its sim, so it is "still replaying".
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_CLIENT_INPUTS_PER_TICK } from "../../server/clock.ts";
import { GameDb } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { World } from "../../server/world.ts";
import { startServer, type RunningServer } from "../../server/main.ts";
import { KIND_JOIN, KIND_PAINT } from "../../shared/inputs.ts";
import { decodeServer, encodeTick } from "../../shared/protocol.ts";
import { buildHashHex, connect, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-hold-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string, extra: { catchupHoldMaxMs?: number; snapshotEveryTicks?: number } = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, snapshotEveryTicks: 120, quiet: true, ...extra });
  cleanups.push(() => s.close());
  return s;
}
/** A server dir whose sandbox log already holds n empty ticks (as persistence.test.ts "cold start with a long log"). */
async function seeded(n: number): Promise<string> {
  const dir = tmp();
  await (await boot(dir)).close();
  const db = new GameDb(dir);
  const row = db.getWorld(0)!;
  for (let start = 1; start <= n; start += 5000) {
    const end = Math.min(n, start + 4999);
    const frames: Uint8Array[] = [];
    for (let t = start; t <= end; t++) frames.push(encodeTick(t, []));
    const data = new Uint8Array(frames.reduce((a, f) => a + f.length, 0));
    let o = 0;
    for (const f of frames) {
      data.set(f, o);
      o += f.length;
    }
    db.appendTicks(0, start, end, row.simBuild, data);
  }
  db.close();
  return dir;
}
const events = (s: RunningServer, ev: string) => s.log.recent().filter((e) => e.ev === ev);
const summary = async (s: RunningServer) => ((await (await fetch(`http://127.0.0.1:${s.port}/api/summary`)).json()) as any).worlds[0];
/** The client reaches its replay target: this is what the real worker does, and the helper sends LIVE then. */
const finishReplay = (c: { ls: { run(n: number): number } }) => c.ls.run(1_000_000);

describe("a lone client catching up holds the clock", () => {
  it("lastClosed does not advance while it replays 5000 ticks, and advances again after LIVE", async () => {
    const N = 5000;
    const s = await boot(await seeded(N));
    expect(s.world.clock.lastClosed).toBe(N);
    const c = await connect(s.port, hex, { manual: true });
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      samples.push(s.world.clock.lastClosed);
      await sleep(50);
    }
    expect(samples).toEqual(new Array(12).fill(N)); // 600 ms is 36 ticks at 60 Hz: they must not have closed
    expect(s.world.held).toBe(true);
    expect((await summary(s)).held).toBe(true);
    expect(events(s, "world.hold")).toHaveLength(1);
    finishReplay(c);
    await waitFor(() => s.world.clock.lastClosed > N + 20, 5000, "the clock to run after LIVE");
    expect(s.world.held).toBe(false);
    expect((await summary(s)).held).toBe(false);
    const rel = events(s, "world.release");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ reason: "live", tick: N });
    expect(rel[0]!.ms as number).toBeGreaterThanOrEqual(500);
    c.close();
  }, 30_000);

  it("a fresh empty world has nothing to catch up: the first client is live at once and the clock runs", async () => {
    const s = await boot(tmp());
    const c = await connect(s.port, hex, { manual: true });
    await waitFor(() => s.world.clock.lastClosed >= 20, 3000, "ticks");
    expect(s.world.held).toBe(false);
    c.close();
  });
});

describe("a joiner with nothing to replay holds nothing", () => {
  it("a client that never sends LIVE, joining an empty world, sees the clock run and its paint land", async () => {
    // D-131: the first visitor to an empty world used to start not-live, so the world froze until their LIVE came.
    // A client that never sends one (an older tab, the course's CI spec clients) froze it for the whole valve.
    const s = await boot(tmp());
    const c = await connect(s.port, hex, { holdLive: true });
    await sleep(500);
    expect(s.world.held).toBe(false);
    expect(s.world.clock.lastClosed).toBeGreaterThan(10);
    c.close();
  }, 30_000);
});

describe("a live player is never frozen by a joiner", () => {
  it("one live client keeps ticking the whole time a second client replays", async () => {
    const N = 3000;
    const s = await boot(await seeded(N));
    const a = await connect(s.port, hex, { manual: true });
    finishReplay(a); // a is live
    await waitFor(() => s.world.clock.lastClosed > N + 10, 5000, "a to be ticking");
    const holdsBefore = events(s, "world.hold").length; // a's own join held the clock once, until it went live
    expect(holdsBefore).toBe(1);
    const b = await connect(s.port, hex, { manual: true }); // b replays and never steps
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(s.world.clock.lastClosed);
      await sleep(60);
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThan(samples[i - 1]); // ~3 ticks per 60 ms, every window
    expect(s.world.held).toBe(false);
    expect(events(s, "world.hold")).toHaveLength(holdsBefore); // b's join added none
    a.close();
    b.close();
  }, 30_000);

  it("a resync of one member does not freeze a world with another live member", async () => {
    const s = await boot(tmp());
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    await waitFor(() => s.world.clock.lastClosed >= 30, 3000, "ticks");
    const m = [...s.world.members.values()].find((x) => x.id !== [...s.world.members.keys()][0])!;
    (s.world as unknown as { resync(m: unknown): void }).resync(m);
    expect(m.live).toBe(false);
    const at = s.world.clock.lastClosed;
    await sleep(300);
    expect(s.world.clock.lastClosed).toBeGreaterThan(at + 10);
    expect(s.world.held).toBe(false);
    a.close();
    b.close();
  }, 30_000);

  it("a resync of the only member holds the clock until it is live again", async () => {
    const s = await boot(tmp());
    const a = await connect(s.port, hex, { manual: true });
    await waitFor(() => s.world.clock.lastClosed >= 30, 3000, "ticks");
    const m = [...s.world.members.values()][0]!;
    (s.world as unknown as { resync(m: unknown): void }).resync(m);
    expect(s.world.held).toBe(true);
    const at = s.world.clock.lastClosed;
    await sleep(200);
    expect(s.world.clock.lastClosed).toBe(at);
    // This manual client never steps, so it never replays the RESYNC: a LIVE from it now names its old tick, which
    // predates the resync and is stale (review catch-up N2). A real client sends LIVE once it reaches the new target.
    a.sendLive();
    await sleep(200);
    expect(s.world.held).toBe(true);
    s.world.onLive([...s.world.members.keys()][0]!, at);
    await waitFor(() => s.world.clock.lastClosed > at + 10, 3000, "ticks after LIVE");
    a.close();
  }, 30_000);
});

describe("the safety valve", () => {
  it("a client that never reports live holds the world for CATCHUP_HOLD_MAX_MS and no longer", async () => {
    const N = 2000;
    const s = await boot(await seeded(N), { catchupHoldMaxMs: 500 });
    const t0 = performance.now();
    const c = await connect(s.port, hex, { manual: true });
    await sleep(300);
    expect(s.world.clock.lastClosed).toBe(N);
    expect(s.world.held).toBe(true);
    await waitFor(() => s.world.clock.lastClosed > N, 5000, "the valve to open");
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(2000);
    expect(s.world.held).toBe(false);
    const rel = events(s, "world.release");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ reason: "expired" });
    expect(events(s, "world.hold_expired")).toHaveLength(1);
    c.close();
  }, 30_000);
});

describe("inputs during a hold", () => {
  it("client inputs sent while held are dropped; the server's Join still lands in the first tick after release", async () => {
    // Review catch-up N1: a held clock let one open tick collect minutes of input, past the TICK frame's u16
    // count. Only members still replaying exist while held, and a replaying client sends no play, so the world
    // takes none: nothing a person did is lost. Join and Leave are the server's and are never dropped.
    const N = 1000;
    const s = await boot(await seeded(N));
    const c = await connect(s.port, hex, { manual: true });
    for (const x of [11, 22, 33, 44]) c.paint(4, x, 100, x + 1, 100, 2);
    await sleep(300);
    expect(s.world.clock.lastClosed).toBe(N);
    expect(s.world.clock.openCount).toBe(1); // only the server's Join waits in the open tick
    expect(events(s, "input.rejected").some((e) => e.reason === "world_held")).toBe(true);
    finishReplay(c);
    await waitFor(() => s.world.clock.lastClosed > N + 5, 5000, "release");
    const frames = s.world.log.slice(N).map((f) => decodeServer(f)!);
    const withInputs = frames.filter((f) => f.t === "tick" && f.inputs.length > 0) as { t: "tick"; tick: number; inputs: { kind: number }[] }[];
    expect(withInputs).toHaveLength(1);
    expect(withInputs[0]!.tick).toBe(N + 1);
    expect(withInputs[0]!.inputs.map((i) => i.kind)).toEqual([KIND_JOIN]);
    c.close();
  }, 30_000);

  it("a stale LIVE (for a tick below the member's replay start) does not end a hold", async () => {
    // Review catch-up N2: a LIVE that crossed a RESYNC named a tick from before the replay it now has to do.
    const N = 1000;
    const s = await boot(await seeded(N));
    const c = await connect(s.port, hex, { manual: true });
    await sleep(200);
    expect(s.world.held).toBe(true);
    const conn = [...s.world.members.keys()][0]!; // the only member
    s.world.onLive(conn, N - 1); // the member's replay target is N; a LIVE for N - 1 predates it
    await sleep(300);
    expect(s.world.held).toBe(true);
    expect(s.world.clock.lastClosed).toBe(N);
    s.world.onLive(conn, N); // reaching the target is a real LIVE
    await waitFor(() => !s.world.held, 3000, "a real LIVE releases");
    c.close();
  }, 30_000);
});

describe("the per-tick input cap", () => {
  it("a world takes at most MAX_CLIENT_INPUTS_PER_TICK client inputs in one tick, and Join and Leave always land", () => {
    const w = new World({ id: 0, now: () => 0, log: new EventLog({ quiet: true }) });
    w.clock.resume();
    const input = { player: 1, kind: KIND_PAINT, payload: new Uint8Array(10) };
    let took = 0;
    for (let i = 0; i < MAX_CLIENT_INPUTS_PER_TICK + 50; i++) if (w.stampClient(input)) took++;
    expect(took).toBe(MAX_CLIENT_INPUTS_PER_TICK);
    w.stamp({ player: 1, kind: KIND_JOIN, payload: new Uint8Array(0) });
    expect(w.clock.openCount).toBe(MAX_CLIENT_INPUTS_PER_TICK + 1);
  });

  it("encodeTick refuses a count its u16 field cannot hold, rather than writing a wrapped one", () => {
    const one = { player: 1, kind: KIND_JOIN, payload: new Uint8Array(0) };
    expect(() => encodeTick(1, new Array(0x10000).fill(one))).toThrow(RangeError);
    expect(decodeServer(encodeTick(1, new Array(0xffff).fill(one)))).toMatchObject({ t: "tick" });
  });
});

describe("recovery from a long log, end to end", () => {
  it("the log stops growing while a lone client replays 20,000 ticks, and a snapshot follows soon after LIVE", async () => {
    const N = 20_000;
    const s = await boot(await seeded(N));
    const c = await connect(s.port, hex, { manual: true });
    const start = s.world.log.length;
    expect(start).toBe(N);
    await sleep(1500); // 90 ticks of clock time: before the change the log was N + 90 here
    expect(s.world.log.length).toBe(N);
    expect((await summary(s)).ticksSinceSnapshot).toBe(N);
    const stepper = setInterval(() => c.ls.run(100_000), 5);
    cleanups.push(() => clearInterval(stepper));
    finishReplay(c);
    await waitFor(() => s.world.stats.snapshotsAccepted >= 1, 60_000, "a verified snapshot after LIVE");
    const after = await summary(s);
    expect(after.snapshotTick).toBeGreaterThan(N);
    expect(after.snapshotTick).toBeLessThan(N + 1000); // a live-only request, a few seconds after going live
    expect(after.ticksSinceSnapshot).toBeLessThan(2000);
    c.close();
  }, 120_000);
});
