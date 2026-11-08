// D-228: a warm snapshot-verify lane per occupied room. Before it, ONE verify worker kept one cached generated world, so
// two rooms (each with its own seed, D-201) verifying in turn regenerated the world on every verify: 6-18 s at M and
// 35-50 s at L on the Fly quota, against a 10 s timeout (docs/research/capacity-2026-11-07.md, D-213).
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../../server/log.ts";
import { SnapshotVerifier, laneBytes, type VerifyRoom } from "../../server/verify.ts";
import { World, type Peer } from "../../server/world.ts";
import { compressSnapshot, maxSnapshotRawFor } from "../../shared/protocol.ts";
import { CLASSIC_SANDBOX, SURVIVAL, encodeConfig, isCaves, type RoomConfig } from "../../shared/room.ts";
import { loadSim } from "../../shared/sim.ts";
import { WASM, waitFor, wasmBytes } from "./helpers.ts";

// S-size Survival: a cave world with a cached base (D-088), small enough to generate in about 100 ms.
const CFG: RoomConfig = { ...SURVIVAL, size: 0 };
const MAX_RAW = maxSnapshotRawFor(CFG);

/** A client's snapshot of a world after `steps` ticks, compressed as uploaded. */
function snapshotOf(seed: bigint, steps = 30, cfg: RoomConfig = CFG): { data: Uint8Array; hash: bigint; tick: number } {
  const s = loadSim(wasmBytes);
  s.init(seed, encodeConfig(cfg));
  for (let i = 0; i < steps; i++) s.step();
  return { data: compressSnapshot(s.snapshot()), hash: s.stateHash(), tick: s.tick() };
}
const room = (id: number, seed: bigint, cfg: RoomConfig = CFG): VerifyRoom => ({ id, seed, cfg: encodeConfig(cfg), size: cfg.size, caves: isCaves(cfg) });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function verifier(opts: ConstructorParameters<typeof SnapshotVerifier>[1] = {}): SnapshotVerifier {
  const v = new SnapshotVerifier(WASM, opts);
  cleanups.push(() => v.close());
  return v;
}

describe("warm verify lanes (D-228)", () => {
  const A = room(101, 0xa11cen);
  const B = room(102, 0xb0bn);
  const snapA = snapshotOf(A.seed);
  const snapB = snapshotOf(B.seed);

  it("two rooms with different seeds, verifying in turn: only each room's first verify may be cold, none after", async () => {
    const v = verifier();
    const got: { room: number; cold: boolean | undefined }[] = [];
    for (let i = 0; i < 3; i++) {
      for (const [r, s] of [[A, snapA], [B, snapB]] as const) {
        const res = await v.check(s.data, MAX_RAW, r);
        expect(res.kind).toBe("ok");
        if (res.kind !== "ok") return;
        // The trust path is unchanged: the restored tick and hash are the client's exactly.
        expect(res.v.tick).toBe(s.tick);
        expect(res.v.hash).toBe(s.hash);
        got.push({ room: r.id, cold: res.v.cold });
      }
    }
    // Each lane generated its room's world from the room's own seed when it opened, so even the first verify was warm.
    expect(got.every((g) => g.cold === false)).toBe(true);
    expect(v.coldRestores).toBe(0);
    expect(v.laneIds().sort()).toEqual([101, 102]);
  });

  it("without lanes (budget 0, the old single worker's behaviour) the same alternation is cold every time", async () => {
    const v = verifier({ warmBudgetBytes: 0 });
    for (let i = 0; i < 2; i++) {
      for (const [r, s] of [[A, snapA], [B, snapB]] as const) {
        const res = await v.check(s.data, MAX_RAW, r);
        expect(res.kind === "ok" && res.v.cold).toBe(true);
        expect(res.kind === "ok" && res.v.hash).toBe(s.hash);
      }
    }
    expect(v.coldRestores).toBe(4);
    expect(v.laneIds()).toEqual([]);
  });

  it("a released room's lane is dropped, and a room past the budget verifies on the overflow worker", async () => {
    const v = verifier({ warmBudgetBytes: laneBytes(0) }); // room for exactly one S lane
    expect(v.warm(A)).toBe(true);
    expect(v.warm(B)).toBe(false); // over budget
    const rb = await v.check(snapB.data, MAX_RAW, B);
    expect(rb.kind === "ok" && rb.path).toBe("overflow");
    expect(rb.kind === "ok" && rb.v.hash).toBe(snapB.hash);
    v.release(A.id, true); // unloaded: no linger
    expect(v.laneIds()).toEqual([]);
    expect(v.laneBytesInUse()).toBe(0); // nothing was in flight, so the worker was terminated at once
    expect(v.warm(B)).toBe(true); // the budget came back
  });

  it("no lane opens that would leave less than the memory reserve free", () => {
    const v = verifier({ memoryFreeBytes: () => 80 * 1048576, memoryReserveBytes: 56 * 1048576 });
    expect(v.warm(room(103, 3n, { ...SURVIVAL, size: 1 }))).toBe(false); // an M lane (~33 MB) would leave ~47 MB
    expect(v.warm(A)).toBe(true); // an S lane (~19 MB) leaves ~61 MB
  });

  it("a verify that hangs in one room's lane times out alone: another room's lane stays warm, and the hung room is barred until released", async () => {
    const v = verifier({ timeoutMs: 1000, workerUrl: new URL("./hang-room-worker.ts", import.meta.url) });
    const H = room(103, 666n); // hang-room-worker.ts hangs every verify of the room it prewarmed with seed 666
    expect((await v.check(snapB.data, MAX_RAW, B)).kind).toBe("ok");
    const pendingB = v.check(snapB.data, MAX_RAW, B);
    const r = await v.check(snapshotOf(H.seed).data, MAX_RAW, H);
    expect(r).toMatchObject({ kind: "unavailable", why: "timeout", path: "lane" });
    expect(v.timeouts).toBe(1);
    expect(await pendingB).toMatchObject({ kind: "ok", path: "lane" }); // B's job was not failed with H's
    expect(v.laneIds()).toEqual([102]); // H's lane is gone, and is not reopened (and regenerated) on every verify
    expect(v.warm(H)).toBe(false);
    const again = await v.check(snapB.data, MAX_RAW, B);
    expect(again.kind === "ok" && again.v.cold).toBe(false);
    expect(v.coldRestores).toBe(0);
    v.release(H.id, true); // the room emptied and unloaded: that no longer lifts the bar (review S2-4: churn defeated it)
    expect(v.warm(H)).toBe(false);
  });

  it("a timed-out room's bar lifts after LANE_BAR_MS, not on a release", async () => {
    let t = 0;
    const v = verifier({ timeoutMs: 500, barMs: 1000, now: () => t, workerUrl: new URL("./hang-room-worker.ts", import.meta.url) });
    const H = room(104, 666n);
    expect(await v.check(snapshotOf(H.seed).data, MAX_RAW, H)).toMatchObject({ kind: "unavailable", why: "timeout", path: "lane" });
    v.release(H.id, true);
    expect(v.warm(H)).toBe(false);
    t = 999;
    expect(v.warm(H)).toBe(false);
    t = 1000;
    expect(v.warm(H)).toBe(true);
  });

  it("a lane whose generation outlasts the warm-up bound is retired alone, and another lane stays warm", async () => {
    // A lane whose first generation never finishes (hang-room-worker.ts, seed 667) is killed alone at the warm-up bound.
    const v = verifier({ warmTimeoutMs: 3000, workerUrl: new URL("./hang-room-worker.ts", import.meta.url) });
    const big = room(201, 667n);
    expect(v.warm(B)).toBe(true);
    expect((await v.check(snapB.data, MAX_RAW, B)).kind).toBe("ok");
    expect(v.warm(big)).toBe(true);
    await waitFor(() => !v.laneIds().includes(201), 5000, "the hung lane times out and is retired");
    expect(v.timeouts).toBe(1);
    const rb = await v.check(snapB.data, MAX_RAW, B);
    expect(rb).toMatchObject({ kind: "ok", path: "lane" });
    expect(rb.kind === "ok" && rb.v.cold).toBe(false);
    expect(v.coldRestores).toBe(0);
  });

  it("a hostile snapshot is still refused on a lane: garbage, an oversized stream, and another world's snapshot", async () => {
    const v = verifier();
    expect((await v.check(new Uint8Array([1, 2, 3, 4]), MAX_RAW, A)).kind).toBe("refused");
    expect(await v.check(snapA.data, 100, A)).toMatchObject({ kind: "refused", stage: "decompress" });
    // Another seed's valid snapshot on A's lane: refused before it can make the lane regenerate, and A stays warm.
    expect(await v.check(snapB.data, MAX_RAW, A)).toMatchObject({ kind: "refused", stage: "restore" });
    const ra = await v.check(snapA.data, MAX_RAW, A);
    expect(ra.kind === "ok" && ra.v.cold).toBe(false);
    expect(ra.kind === "ok" && ra.v.hash).toBe(snapA.hash);
    // With no room (start-up's check) any valid snapshot still verifies, on the overflow worker.
    expect(await v.check(snapB.data, MAX_RAW)).toMatchObject({ kind: "ok", path: "overflow" });
  });

  it("a World opens its lane on the first join and drops it when the last member leaves and on shutdown", async () => {
    const v = verifier({ lingerMs: 0 });
    const w = new World({ id: 301, cfg: CFG, seed: 77n, now: () => performance.now(), log: new EventLog({ quiet: true }), verifier: v });
    const peer: Peer = { send() {}, buffered: () => 0, close() {} };
    const a = w.join(peer);
    expect(v.laneIds()).toEqual([301]);
    const b = w.join(peer);
    w.leave(a.conn);
    expect(v.laneIds()).toEqual([301]);
    w.leave(b.conn);
    expect(v.laneIds()).toEqual([]);
    w.join(peer);
    expect(v.laneIds()).toEqual([301]);
    w.shutdown();
    expect(v.laneIds()).toEqual([]);
  });

  it("a lane lingers after the last leave, so a join/leave loop generates the world once (review S2-2); an unload releases at once and a reload opens a fresh warm lane", async () => {
    const v = verifier({ lingerMs: 60_000 });
    const w = new World({ id: 302, cfg: CFG, seed: 78n, now: () => performance.now(), log: new EventLog({ quiet: true }), verifier: v });
    const peer: Peer = { send() {}, buffered: () => 0, close() {} };
    for (let i = 0; i < 5; i++) w.leave(w.join(peer).conn);
    expect(v.lanesOpened).toBe(1);
    expect(v.laneIds()).toEqual([302]); // lingering
    w.shutdown();
    expect(v.laneIds()).toEqual([]); // an unload (an owned room's, a delete) releases at once, no linger
    // A reload is a new World for the same row: a fresh lane, prewarmed from the stored seed, and its verify is warm.
    const again = new World({ id: 302, cfg: CFG, seed: 78n, now: () => performance.now(), log: new EventLog({ quiet: true }), verifier: v });
    again.join(peer);
    expect(v.laneIds()).toEqual([302]);
    expect(v.lanesOpened).toBe(2);
    const snap = snapshotOf(78n);
    const r = await v.check(snap.data, MAX_RAW, room(302, 78n));
    expect(r).toMatchObject({ kind: "ok", path: "lane" });
    expect(r.kind === "ok" && r.v.cold).toBe(false);
    expect(r.kind === "ok" && r.v.hash).toBe(snap.hash);
    again.shutdown();
  });

  it("a box-terrain room gets no lane: the sim caches no base for it, so a lane would buy nothing", async () => {
    const v = verifier();
    const box = room(303, 5n, CLASSIC_SANDBOX);
    expect(v.warm(box)).toBe(false);
    const s = loadSim(wasmBytes);
    s.init(box.seed, box.cfg);
    for (let i = 0; i < 10; i++) s.step();
    const r = await v.check(compressSnapshot(s.snapshot()), maxSnapshotRawFor(CLASSIC_SANDBOX), box);
    expect(r).toMatchObject({ kind: "ok", path: "overflow" });
    expect(r.kind === "ok" && r.v.hash).toBe(s.stateHash());
    expect(v.lanesOpened).toBe(0);
  });

  it("a released lane still answering a verify counts in the budget until its worker exits", async () => {
    const v = verifier({ warmBudgetBytes: laneBytes(0), lingerMs: 0 });
    expect(v.warm(A)).toBe(true);
    const pending = v.check(snapA.data, MAX_RAW, A);
    v.release(A.id);
    expect(v.laneIds()).toEqual([]);
    expect(v.laneBytesInUse()).toBe(laneBytes(0)); // the draining worker still holds A's world
    expect(v.warm(B)).toBe(false);
    expect((await pending).kind).toBe("ok"); // the in-flight verify was answered, not failed
    await waitFor(() => v.laneBytesInUse() === 0, 5000, "the drained worker exits");
    expect(v.warm(B)).toBe(true);
  });

  it("a lane released while its generation hangs is still killed at the warm-up bound, and its verify answered (review S2-3)", async () => {
    const v = verifier({ warmTimeoutMs: 1500, lingerMs: 0, workerUrl: new URL("./hang-room-worker.ts", import.meta.url) });
    const big = room(204, 667n); // hang-room-worker.ts: a prewarm with seed 667 never finishes
    const pending = v.check(snapshotOf(big.seed).data, MAX_RAW, big);
    v.release(big.id);
    const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res("hung"), 5000))]);
    expect(r).toMatchObject({ kind: "unavailable", why: "timeout", path: "lane" });
    expect(v.laneBytesInUse()).toBe(0);
  });
});
