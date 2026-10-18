// Chunk-level desync diagnosis (D-126): REQUEST_CHUNK_HASHES / CHUNK_HASHES, the diff, the incident record, its bounds.
// Bare-World tests use fake peers and a fake clock; the integration tests use the real server and real clients.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  decodeServer,
  encodeChunkHashes,
  S_REQUEST_CHUNK_HASHES,
  S_RESYNC,
  MAX_CHUNK_COUNT,
  type ServerMsg,
} from "../../shared/protocol.ts";
import { GameDb } from "../../server/db.ts";
import { EventLog } from "../../server/log.ts";
import { startServer } from "../../server/main.ts";
import {
  CHUNK_DIAG_WAIT_MS,
  DIAG_WINDOW_MS,
  MAX_CHUNKS_RECORDED,
  MAX_DIAGS_PER_WINDOW,
  MAX_OPEN_DIAGNOSES,
  SANDBOX_ID,
  World,
  type Peer,
} from "../../server/world.ts";
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
  const d = mkdtempSync(join(tmpdir(), "sand-diag-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// ---- bare World ---------------------------------------------------------------------------------------

interface FakePeer extends Peer {
  frames: ServerMsg[];
  tags: number[];
}
const fakePeer = (): FakePeer => {
  const p: FakePeer = {
    frames: [],
    tags: [],
    send(f) {
      p.tags.push(f[0]);
      const m = decodeServer(f);
      if (m) p.frames.push(m);
    },
    buffered: () => 0,
    close() {},
    userAgent: "fake",
  };
  return p;
};

function rig() {
  let t = 1000;
  const dir = tmp();
  const db = new GameDb(dir);
  cleanups.push(() => db.close());
  const log = new EventLog({ quiet: true });
  const w = new World({ id: SANDBOX_ID, now: () => t, log, db });
  const peers: FakePeer[] = [];
  const add = (): number => {
    const p = fakePeer();
    peers.push(p);
    const conn = w.join(p, {}).conn;
    w.onLive(conn, w.clock.lastClosed);
    return conn;
  };
  const advance = (ms: number) => {
    t += ms;
    w.tick();
  };
  const arr = (changes: Record<number, bigint> = {}): BigUint64Array => {
    const a = new BigUint64Array(64).map((_, i) => BigInt(i + 1));
    for (const [i, v] of Object.entries(changes)) a[Number(i)] = v;
    return a;
  };
  /** Everyone reports a state hash for `tick`; `badIds` report a different one. */
  const hashRound = (tick: number, ids: number[], badIds: number[]) => {
    for (const id of ids) w.members.get(id)!.minHashTick = 0;
    for (const id of ids) w.onHash(id, tick, badIds.includes(id) ? 0xbadn : 0x600dn);
  };
  const chunks = (id = 0) => (db.recentIncidents(50).at(id)!.details.chunks as Record<string, any>);
  return { w, db, log, peers, add, advance, arr, hashRound, chunks, now: () => t };
}

describe("chunk diagnosis on a bare World", () => {
  it("diffs a divergent member against the majority and records the differing chunks with their rectangles", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [a, b, bad], [bad]);
    r.w.onChunkHashes(a, 60, r.arr());
    r.w.onChunkHashes(b, 60, r.arr());
    r.w.onChunkHashes(bad, 60, r.arr({ 3: 99n, 40: 98n }));
    const c = r.chunks();
    expect(c.status).toBe("ok");
    expect(c.total).toBe(2);
    expect(c.first).toEqual({ index: 3, cx: 3, cy: 0, x: 192, y: 0, w: 64, h: 64 });
    expect(c.list.map((x: any) => x.index)).toEqual([3, 40]);
    expect(c.list[1]).toEqual({ index: 40, cx: 0, cy: 5, x: 0, y: 320, w: 64, h: 64 });
    expect(c.asked).toBe(3);
    expect(c.byPlayer[bad]).toMatchObject({ count: 2, first: 3 });
    const ev = r.log.recent().filter((e) => e.ev === "desync.chunks");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ world: 0, tick: 60, first_chunk: 3, first_cx: 3, first_cy: 0, count: 2 });
    expect(String(ev[0].who)).toContain("anon#c");
  });

  it("asks every member that reported, the agreeing majority too, and never asks a non-reporter", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    const silent = r.add();
    r.advance(2000);
    r.w.members.get(silent)!.minHashTick = 1_000_000; // joined later than the tick: not a reporter
    r.hashRound(60, [a, b, bad], [bad]);
    const asked = r.peers.map((p) => p.frames.filter((f) => f.t === "request-chunk-hashes").length);
    expect(asked).toEqual([1, 1, 1, 0]);
    expect(r.peers[0].frames.find((f) => f.t === "request-chunk-hashes")).toEqual({ t: "request-chunk-hashes", tick: 60 });
  });

  it("sends the resync at once, before any chunk reply arrives, and the incident starts as pending", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [a, b, bad], [bad]);
    // No reply has been given yet.
    const badTags = r.peers[2].tags;
    expect(badTags).toContain(S_RESYNC);
    expect(badTags.indexOf(S_REQUEST_CHUNK_HASHES)).toBeGreaterThanOrEqual(0);
    // The request is ahead of the RESYNC on the wire, so a client still has its ring when it answers.
    expect(badTags.lastIndexOf(S_REQUEST_CHUNK_HASHES)).toBeLessThan(badTags.lastIndexOf(S_RESYNC));
    expect(r.w.stats.resyncs).toBe(1);
    expect(r.chunks().status).toBe("pending");
    r.w.onChunkHashes(a, 60, r.arr());
    expect(r.chunks().status).toBe("pending"); // still waiting for the others
  });

  it("marks chunks unavailable when the divergent client's ring no longer holds the tick, without hanging", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [a, b, bad], [bad]);
    r.w.onChunkHashes(a, 60, r.arr());
    r.w.onChunkHashes(b, 60, r.arr());
    r.w.onChunkHashes(bad, 60, new BigUint64Array(0)); // count 0: left the ring
    expect(r.chunks()).toMatchObject({ status: "unavailable", reason: "ring_miss" });
    expect(r.log.recent().filter((e) => e.ev === "desync.chunks")[0]).toMatchObject({ status: "unavailable", reason: "ring_miss", first_chunk: null });
    // Nothing is left open: a late duplicate is just ignored.
    r.w.onChunkHashes(bad, 60, r.arr({ 1: 5n }));
    expect(r.chunks().status).toBe("unavailable");
  });

  it("gives up on a silent client after the wait, and the resync was never delayed", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [a, b, bad], [bad]);
    r.w.onChunkHashes(a, 60, r.arr());
    r.w.onChunkHashes(b, 60, r.arr());
    r.advance(CHUNK_DIAG_WAIT_MS - 500);
    expect(r.chunks().status).toBe("pending");
    r.advance(600);
    expect(r.chunks()).toMatchObject({ status: "unavailable", reason: "timeout" });
  });

  it("a tie between agreeing members' arrays goes to the longest-connected one", () => {
    const r = rig();
    const [old, young, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [old, young, bad], [bad]);
    r.w.onChunkHashes(young, 60, r.arr({ 7: 7777n }));
    r.w.onChunkHashes(old, 60, r.arr());
    r.w.onChunkHashes(bad, 60, r.arr({ 5: 55n }));
    const c = r.chunks();
    // Against old's array the bad one differs at 5 only; against young's it would also differ at 7.
    expect(c.list.map((x: any) => x.index)).toEqual([5]);
  });

  it("an array whose length is not the world's chunk count counts as unavailable", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [a, b, bad], [bad]);
    r.w.onChunkHashes(a, 60, r.arr());
    r.w.onChunkHashes(b, 60, r.arr());
    r.w.onChunkHashes(bad, 60, new BigUint64Array(10));
    expect(r.chunks()).toMatchObject({ status: "unavailable", reason: "ring_miss" });
  });

  it("stores at most MAX_CHUNKS_RECORDED chunks but counts them all", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    r.hashRound(60, [a, b, bad], [bad]);
    const every = r.arr();
    const wrong = every.map((x) => x + 1n); // all 64 differ
    r.w.onChunkHashes(a, 60, every);
    r.w.onChunkHashes(b, 60, every);
    r.w.onChunkHashes(bad, 60, wrong);
    const c = r.chunks();
    expect(c.total).toBe(64);
    expect(c.list.length).toBe(Math.min(64, MAX_CHUNKS_RECORDED));
    expect(MAX_CHUNKS_RECORDED).toBeLessThanOrEqual(64);
  });

  it("ignores unsolicited, wrong-tick, unasked-member and duplicate CHUNK_HASHES cheaply, logging once", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(2000);
    // Nothing open at all: a flood.
    for (let i = 0; i < 500; i++) r.w.onChunkHashes(a, 60, r.arr());
    expect(r.w.stats.chunkUnsolicited).toBe(500);
    expect(r.log.recent().filter((e) => e.reason === "chunk_hashes_unsolicited")).toHaveLength(1);
    r.hashRound(60, [a, b, bad], [bad]);
    const late = r.add(); // joined after the request: never asked
    r.w.onChunkHashes(a, 120, r.arr()); // a tick nobody asked about
    r.w.onChunkHashes(late, 60, r.arr());
    r.w.onChunkHashes(a, 60, r.arr());
    r.w.onChunkHashes(a, 60, r.arr({ 0: 123n })); // a second answer from the same member
    expect(r.w.stats.chunkUnsolicited).toBe(500 + 3);
    r.w.onChunkHashes(b, 60, r.arr());
    r.w.onChunkHashes(bad, 60, r.arr({ 9: 1n }));
    expect(r.chunks().list.map((x: any) => x.index)).toEqual([9]); // the duplicate did not change a's array
  });

  it("caps open diagnoses and the request rate per world", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    r.advance(8000); // 480 ticks: checkpoints 60, 120, ...
    // Nobody answers: MAX_OPEN_DIAGNOSES are asked, the next is refused as too_many_open.
    for (let k = 1; k <= MAX_OPEN_DIAGNOSES + 1; k++) r.hashRound(60 * k, [a, b, bad], [bad]);
    const reasons = r.db.recentIncidents(10).reverse().map((i) => (i.details.chunks as any).reason ?? (i.details.chunks as any).status);
    expect(reasons).toEqual([...Array(MAX_OPEN_DIAGNOSES).fill("pending"), "too_many_open"]);
    const requests = r.peers[0].frames.filter((f) => f.t === "request-chunk-hashes").length;
    expect(requests).toBe(MAX_OPEN_DIAGNOSES);
  });

  it("rate-limits requests per window and recovers after it", () => {
    const r = rig();
    const [a, b, bad] = [r.add(), r.add(), r.add()];
    const answerAll = (tick: number) => {
      r.w.onChunkHashes(a, tick, r.arr());
      r.w.onChunkHashes(b, tick, r.arr());
      r.w.onChunkHashes(bad, tick, r.arr({ 2: 2n }));
    };
    r.advance(30_000); // 1800 ticks, inside one DIAG_WINDOW_MS
    for (let k = 1; k <= MAX_DIAGS_PER_WINDOW; k++) {
      r.hashRound(60 * k, [a, b, bad], [bad]);
      answerAll(60 * k);
    }
    const before = r.peers[0].frames.length;
    r.hashRound(60 * 8, [a, b, bad], [bad]);
    expect((r.db.recentIncidents(1)[0].details.chunks as any).reason).toBe("rate_limited");
    expect(r.peers[0].frames.length).toBe(before); // no request frame went out
    expect(r.log.recent().some((e) => e.ev === "desync.diag_skipped" && e.reason === "rate_limited")).toBe(true);
    r.advance(DIAG_WINDOW_MS); // a fresh window
    r.hashRound(60 * 40, [a, b, bad], [bad]);
    expect((r.db.recentIncidents(1)[0].details.chunks as any).status).toBe("pending");
  });
});

// ---- real server --------------------------------------------------------------------------------------

async function boot() {
  const s = await startServer({ port: 0, dataDir: tmp(), snapshotEveryTicks: 100000, quiet: true });
  cleanups.push(() => s.close());
  return s;
}
const chunksOf = (s: Awaited<ReturnType<typeof boot>>) => s.db!.incidents(0)[0]?.details.chunks as Record<string, any> | undefined;

describe("chunk diagnosis over the real server", () => {
  it("names exactly the chunk whose cell one client's sim differs in", async () => {
    const s = await boot();
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    const bad = await connect(s.port, hex);
    await sleep(300);
    // Rock at (100,100) radius 3 lies wholly in chunk (1,1) = index 1 * 8 + 1 = 9; rock never moves.
    bad.localPaint(2, 100, 100, 3);
    await waitFor(() => bad.counts.resyncs >= 1, 15000, "RESYNC");
    await waitFor(() => !!chunksOf(s) && chunksOf(s)!.status !== "pending", 10000, "diagnosis");
    const inc = s.db!.incidents(0)[0];
    expect(inc.details.divergent).toEqual([bad.playerId]);
    const c = chunksOf(s)!;
    expect(c.status).toBe("ok");
    expect(c.total).toBe(1);
    expect(c.list).toEqual([{ index: 9, cx: 1, cy: 1, x: 64, y: 64, w: 64, h: 64 }]);
    expect(c.first.index).toBe(9);
    expect(c.asked).toBe(3);
    expect(a.chunkRequests).toEqual([inc.tick]);
    expect(b.chunkRequests).toEqual([inc.tick]);
    expect(bad.chunkRequests).toEqual([inc.tick]);
    expect(a.counts.resyncs + b.counts.resyncs).toBe(0);
    const ev = s.log.recent().filter((e) => e.ev === "desync.chunks");
    expect(ev[0]).toMatchObject({ world: 0, tick: inc.tick, first_chunk: 9, count: 1, status: "ok" });
    for (const x of [a, b, bad]) x.close();
  }, 40000);

  it("records chunks as unavailable when the divergent client's ring misses the tick, and the resync still happens", async () => {
    const s = await boot();
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    const bad = await connect(s.port, hex);
    await sleep(300);
    bad.answerChunks = false; // it answers by hand with count 0: the tick is gone from its ring
    bad.localPaint(2, 100, 100, 3);
    await waitFor(() => bad.counts.resyncs >= 1, 15000, "RESYNC");
    await waitFor(() => bad.chunkRequests.length >= 1, 5000, "request");
    expect(chunksOf(s)!.status).toBe("pending");
    bad.ws.send(encodeChunkHashes(bad.chunkRequests[0], new BigUint64Array(0)));
    await waitFor(() => chunksOf(s)!.status !== "pending", 5000, "diagnosis");
    expect(chunksOf(s)).toMatchObject({ status: "unavailable", reason: "ring_miss" });
    for (const x of [a, b, bad]) x.close();
  }, 40000);

  it("times out on a client that never answers", async () => {
    const s = await boot();
    const a = await connect(s.port, hex);
    const b = await connect(s.port, hex);
    const bad = await connect(s.port, hex);
    await sleep(300);
    bad.answerChunks = false;
    bad.localPaint(2, 100, 100, 3);
    await waitFor(() => bad.counts.resyncs >= 1, 15000, "RESYNC");
    await waitFor(() => chunksOf(s)?.status === "unavailable", CHUNK_DIAG_WAIT_MS + 5000, "timeout");
    expect(chunksOf(s)!.reason).toBe("timeout");
    for (const x of [a, b, bad]) x.close();
  }, 40000);

  it("closes a socket whose CHUNK_HASHES frame is over the world's cap, and shrugs off a flood of valid-size ones", async () => {
    const s = await boot();
    const a = await connect(s.port, hex);
    for (let i = 0; i < 300; i++) a.ws.send(encodeChunkHashes(60, new BigUint64Array(64)));
    await sleep(300);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    expect(s.world.stats.chunkUnsolicited).toBe(300);
    expect(s.log.recent().filter((e) => e.reason === "chunk_hashes_unsolicited").length).toBeLessThanOrEqual(1);
    let code = 0;
    a.ws.on("close", (c) => (code = c));
    a.ws.send(encodeChunkHashes(60, new BigUint64Array(65))); // 7 + 8 * 65 > the sandbox's 7 + 8 * 64
    await waitFor(() => code !== 0, 3000, "close");
    expect(code).toBe(1009);
    expect(MAX_CHUNK_COUNT).toBeGreaterThan(768);
  });
});
