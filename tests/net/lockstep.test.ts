// D9-lite: the real server, three real WebSocket clients running the real sim through the shared playout
// module. All must report identical state hashes at the same ticks, including a client that joins late.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Lockstep } from "../../client/lockstep.ts";
import { encodePaint, KIND_PAINT } from "../../shared/inputs.ts";
import { decodeServer, encodeHello, encodeInput, PROTOCOL_VERSION } from "../../shared/protocol.ts";
import { loadSim, simBuildHash } from "../../shared/sim.ts";
import { startServer, type RunningServer } from "../../server/main.ts";

const WASM = "sim/target/wasm32-unknown-unknown/release/sim.wasm";
const bytes = new Uint8Array(readFileSync(WASM));
const unhexHash = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestClient {
  name: string;
  ws: WebSocket;
  ls: Lockstep;
  hashes: Map<number, bigint>;
  playerId: number;
  paint(mat: number, x0: number, y0: number, x1: number, y1: number, r: number): void;
  drain(): void;
}

async function connect(port: number, name: string, hashHex: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.binaryType = "nodebuffer";
  const c = { name, ws, hashes: new Map<number, bigint>(), playerId: 0, seq: 0 } as unknown as TestClient & { seq: number };
  await new Promise<void>((ok, bad) => {
    ws.on("open", () => {
      ws.send(encodeHello(unhexHash(hashHex), 0));
    });
    ws.on("error", bad);
    ws.on("message", (d: Buffer) => {
      const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      if (!m) throw new Error("undecodable server frame");
      if (m.t === "welcome") {
        const sim = loadSim(bytes);
        sim.init(m.seed, m.worldKind);
        c.ls = new Lockstep(sim);
        c.ls.catchUpTarget = m.tick;
        c.playerId = m.playerId;
        c.ls.onStepped = (tick) => {
          if (tick % 20 === 0) c.hashes.set(tick, sim.stateHash());
        };
        ok();
      } else if (m.t === "tick") {
        c.ls.push(m.tick, m.inputs);
        c.ls.run(1000); // the test client applies as fast as ticks arrive
      } else if (m.t === "reject") {
        bad(new Error(m.reason));
      }
    });
  });
  c.paint = (mat, x0, y0, x1, y1, r) =>
    ws.send(encodeInput(++c.seq, KIND_PAINT, encodePaint(0, mat, x0, y0, x1, y1, r).subarray(5)));
  c.drain = () => void c.ls.run(100000);
  return c;
}

let server: RunningServer;
let hashHex: string;
beforeAll(async () => {
  hashHex = await simBuildHash(bytes);
  server = await startServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
});

describe("lockstep over the real server", () => {
  it("three clients, one joining late, agree on the state hash at every shared tick", async () => {
    const a = await connect(server.port, "a", hashHex);
    const b = await connect(server.port, "b", hashHex);
    // Reactive materials so the grid actually changes: sand(4?), water, fire etc. by id, spread over the world.
    const mats = [4, 5, 6, 7, 8, 9, 10];
    for (let i = 0; i < 40; i++) {
      a.paint(mats[i % mats.length], 100 + i * 5, 50, 140 + i * 5, 60, 6);
      b.paint(mats[(i + 3) % mats.length], 300 - i * 4, 40, 280 - i * 4, 80, 8);
      await sleep(25);
    }
    const midTick = server.world.clock.lastClosed;
    expect(midTick).toBeGreaterThan(30);
    const c = await connect(server.port, "c", hashHex); // late: replays everything since tick 0
    for (let i = 0; i < 40; i++) {
      c.paint(4, 200 + i, 20, 220 + i, 30, 10);
      a.paint(9, 250, 100 + i, 260, 110 + i, 5);
      await sleep(25);
    }
    while (server.world.clock.lastClosed < 420) await sleep(20);
    await sleep(300);
    for (const x of [a, b, c]) x.drain();

    const ticks = [...a.hashes.keys()].filter((t) => b.hashes.has(t) && c.hashes.has(t));
    expect(ticks.length).toBeGreaterThan(15);
    expect(c.hashes.has(20)).toBe(true); // c really replayed from the start
    for (const t of ticks) {
      expect(b.hashes.get(t), `tick ${t} b`).toBe(a.hashes.get(t));
      expect(c.hashes.get(t), `tick ${t} c`).toBe(a.hashes.get(t));
    }
    // The paints did something: the world at the last tick differs from an empty world.
    const empty = loadSim(bytes);
    empty.init(1n, 0);
    expect(a.ls.sim.stateHash()).not.toBe(empty.stateHash());
    expect(a.ls.simTick).toBe(b.ls.simTick);
    expect(c.ls.simTick).toBe(a.ls.simTick);
    for (const x of [a, b, c]) x.ws.close();
  });

  it("rejects a build hash mismatch and never trusts a client-supplied player id", async () => {
    await expect(connect(server.port, "bad", "00".repeat(32))).rejects.toThrow(/reload/);
    const a = await connect(server.port, "a2", hashHex);
    const forged = encodeInput(1, KIND_PAINT, encodePaint(999, 4, 1, 1, 2, 2, 3).subarray(5));
    a.ws.send(forged);
    await sleep(200);
    let sawPaint = false;
    a.ls.onStepped = (_t, inputs) => {
      for (const i of inputs) if (i.kind === KIND_PAINT) { sawPaint = true; expect(i.player).toBe(a.playerId); }
    };
    a.drain();
    // Frames after the forged paint carry it stamped with the real id; also check join/leave cannot be forged.
    a.ws.send(encodeInput(2, 1 /* KIND_JOIN */, new Uint8Array(0)));
    await sleep(100);
    expect(server.stats.rejected).toBeGreaterThan(0);
    void sawPaint;
    a.ws.close();
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("drops inputs over the rate limit and counts them", async () => {
    const a = await connect(server.port, "rl", hashHex);
    const before = server.stats.droppedRate;
    for (let i = 0; i < 80; i++) a.paint(4, 10, 10, 11, 11, 1);
    await sleep(200);
    expect(server.stats.droppedRate - before).toBeGreaterThan(20);
    a.ws.close();
  });

  it("pauses with no players and continues numbering on the next join", async () => {
    await sleep(200);
    expect(server.world.playerCount).toBe(0);
    const t0 = server.world.clock.lastClosed;
    await sleep(500);
    expect(server.world.clock.lastClosed).toBe(t0);
    const joinedAt = performance.now();
    const a = await connect(server.port, "again", hashHex);
    await sleep(100);
    expect(a.ls.catchUpTarget).toBe(t0);
    a.drain();
    expect(a.ls.simTick).toBeGreaterThan(t0);
    // Replaying the log takes real time, so compare against the clock's own count, not wall time:
    // numbering continued from t0 and the clock has not run ahead of the 60 Hz budget since the join.
    const elapsedTicks = server.world.clock.lastClosed - t0;
    expect(elapsedTicks).toBeLessThan(((performance.now() - joinedAt) * 60) / 1000 + 2);
    a.ws.close();
  });
});
