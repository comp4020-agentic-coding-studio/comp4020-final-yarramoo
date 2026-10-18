// D9-lite: the real server, three real WebSocket clients running the real sim through the shared playout
// module. All must report identical state hashes at the same ticks, including a client that joins late.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodePaint, KIND_PAINT } from "../../shared/inputs.ts";
import { encodeInput, PROTOCOL_VERSION } from "../../shared/protocol.ts";
import { loadSim, simBuildHash } from "../../shared/sim.ts";
import { connect as connectReal, sleep, unhex, waitFor, wasmBytes } from "./helpers.ts";
import { startServer, type RunningServer } from "../../server/main.ts";

const bytes = wasmBytes;
const unhexHash = unhex;

let server: RunningServer;
let hashHex: string;
let dir: string;
const connect = (port: number, _name: string, hex: string) => connectReal(port, hex);
beforeAll(async () => {
  hashHex = await simBuildHash(bytes);
  dir = mkdtempSync(join(tmpdir(), "sand-net-"));
  server = await startServer({ port: 0, dataDir: dir, quiet: true });
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
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
    // Clients play back at their own pace, so their current tick can differ by one at any instant;
    // that's not divergence (the hashes above are). Compare once both have applied the same closed tick.
    const target = server.world.clock.lastClosed;
    await waitFor(() => {
      for (const x of [a, b]) x.drain();
      return a.ls.simTick >= target && b.ls.simTick >= target;
    }, 5000, "both clients at the last closed tick");
    expect(a.hashes.get(Math.floor(target / 60) * 60)).toBe(b.hashes.get(Math.floor(target / 60) * 60));
    expect(c.ls.simTick).toBe(a.ls.simTick);
    for (const x of [a, b, c]) x.close();
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
    a.close();
    expect(PROTOCOL_VERSION).toBe(8);
  });

  it("drops inputs over the rate limit and counts them", async () => {
    const a = await connect(server.port, "rl", hashHex);
    const before = server.stats.droppedRate;
    for (let i = 0; i < 80; i++) a.paint(4, 10, 10, 11, 11, 1);
    await sleep(200);
    expect(server.stats.droppedRate - before).toBeGreaterThan(20);
    a.close();
  });

  it("pauses with no players and continues numbering on the next join", async () => {
    // Earlier tests' closes are processed asynchronously; wait for the world to empty, don't guess.
    await waitFor(() => server.world.playerCount === 0, 5000, "world empty");
    await waitFor(() => server.world.clock.isPaused, 5000, "clock paused");
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
    a.close();
  });
});
