// Capacity bench, rooms variant (R2c, plan-game-modes.md milestone R2 table: "the capacity measurement (Docker
// image, 24 sockets over 4 rooms, a forced verify; pass is under 200 MB)"). `pnpm soak:capacity-rooms`.
//
// Unlike tests/soak/capacity.ts (the pre-R2 bench: two FIXED worlds, a 0..64-member ramp), this bench creates 4
// REAL rooms over the real HTTP API (POST /api/rooms, same as a browser lobby would), joins 6 bots to each (24
// total) over the real socket/HELLO path, holds briefly, forces a snapshot verify in every room, and reports
// cgroup memory against the 200 MB bar. It does not repeat the ramp; see capacity.ts for that and
// docs/research/capacity-rooms.md for the model this bench's numbers update.
//
// Env: HOLD_S (default 30), PORT (default 8094), OUT.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import WebSocket from "ws";
import { Lockstep, reactToTick } from "../../client/lockstep.ts";
import { encodePos, KIND_POS, unhex } from "../../shared/inputs.ts";
import { CAVES_PVP, CLASSIC_SANDBOX, encodeConfig, type RoomConfig } from "../../shared/room.ts";
import { decodeServer, encodeHash, encodeHello, encodeInput, encodeLive, encodePing, encodeSnapshotUpload } from "../../shared/protocol.ts";
import { loadSim, simBuildHash, type Sim } from "../../shared/sim.ts";

const PORT = Number(process.env.PORT ?? 8094);
const NAME = "cap-bench-rooms";
const WORKERS = 4;
const BOTS_PER_ROOM = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------- bot (worker)
//
// Every bot is a real game-world avatar (Pos ~30/s, the same real rate capacity.ts's world-1 bots use), since
// all 4 rooms here are Caves-preset (avatars: 1) rooms — see "room mix" below.

interface BotCounters {
  room: number;
  bytes: number;
  frames: number;
  opened: boolean;
  closed: boolean;
  hashes: number;
  snaps: number;
  resyncs: number;
  rejected: string;
}

function startBot(wasm: Uint8Array, hashHex: string, id: number, room: number, token: Uint8Array, ip: string): BotCounters {
  const c: BotCounters = { room, bytes: 0, frames: 0, opened: false, closed: false, hashes: 0, snaps: 0, resyncs: 0, rejected: "" };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { "fly-client-ip": ip } });
  ws.binaryType = "nodebuffer";
  let ls: Lockstep | null = null;
  let seq = 0;
  let playerId = 0;
  let seed = 0n;
  let cfg: Uint8Array = new Uint8Array(0);
  let wantSnapshotAt = 0;
  let ent = { x: 0, y: 0, life: 0, ok: false };
  let flip = 0;
  const timers: NodeJS.Timeout[] = [];

  const begin = (target: number) => {
    const sim: Sim = loadSim(wasm);
    sim.init(seed, cfg);
    ls = new Lockstep(sim);
    ls.catchUpTarget = target;
    ls.onStepped = (tick) => {
      if (!ls || ws.readyState !== WebSocket.OPEN) return;
      const r = reactToTick(ls, tick, wantSnapshotAt);
      if (r.hash !== undefined) {
        ws.send(encodeHash(tick, r.hash, 0, ls.buffered));
        c.hashes++;
      }
      if (r.snapshot) {
        wantSnapshotAt = 0;
        ws.send(encodeSnapshotUpload(tick, r.snapshot.hash, r.snapshot.data));
        c.snaps++;
      }
    };
    wantSnapshotAt = 0;
    ent.ok = false;
  };
  let liveSent = false;
  const maybeLive = () => {
    if (ls && !liveSent && !ls.fastForwarding && ws.readyState === WebSocket.OPEN) {
      liveSent = true;
      ws.send(encodeLive(ls.sim.tick()));
    }
  };

  ws.on("open", () => {
    c.opened = true;
    ws.send(encodeHello(unhex(hashHex), room, token));
  });
  ws.on("error", () => {
    c.closed = true;
  });
  ws.on("close", () => {
    c.closed = true;
    for (const t of timers) clearInterval(t);
  });
  ws.on("message", (d: Buffer) => {
    c.bytes += d.length;
    c.frames++;
    const m = decodeServer(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    if (!m) return ws.close();
    switch (m.t) {
      case "welcome":
        playerId = m.playerId;
        seed = m.seed;
        cfg = m.cfg;
        liveSent = false;
        begin(m.tick);
        maybeLive();
        timers.push(setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(encodePing(Math.round(performance.now()) >>> 0)), 2000));
        startPlay();
        break;
      case "snapshot":
        ls?.loadSnapshot(m.data, m.tick);
        break;
      case "resync":
        c.resyncs++;
        begin(m.tick);
        break;
      case "request-snapshot":
        wantSnapshotAt = m.tick;
        break;
      case "tick":
        if (!ls) return ws.close();
        ls.push(m.tick, m.inputs);
        ls.run(100000);
        maybeLive();
        break;
      case "reject":
        c.rejected = m.reason;
        break;
      default:
        break;
    }
  });

  const startPlay = () => {
    // Re-read the avatar's place twice a second; send a Pos every 33 ms (about 30/s) with a one-unit wiggle —
    // the same real rate and shape capacity.ts's world-1 (cave) bots use.
    timers.push(
      setInterval(() => {
        if (!ls || ls.fastForwarding) return;
        const e = ls.sim.entities().find((x) => x.type === 1 && x.id === playerId);
        if (e) ent = { x: e.x, y: e.y, life: e.a, ok: true };
      }, 500),
    );
    timers.push(
      setInterval(() => {
        if (!ent.ok || !ls || ls.fastForwarding || ws.readyState !== WebSocket.OPEN) return;
        flip ^= 1;
        ws.send(encodeInput(++seq, KIND_POS, encodePos(0, ent.life, ent.x + flip, ent.y, 0).subarray(5)));
      }, 33),
    );
  };
  return c;
}

if (!isMainThread) {
  const wasm: Uint8Array = workerData.wasm;
  const hashHex: string = workerData.hashHex;
  const bots = new Map<number, BotCounters>();
  let lagMax = 0;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    lagMax = Math.max(lagMax, now - last - 100);
    last = now;
  }, 100);
  parentPort!.on("message", (m: { cmd: string; id: number; room: number; token: string; ip: string }) => {
    if (m.cmd === "add") bots.set(m.id, startBot(wasm, hashHex, m.id, m.room, unhex(m.token), m.ip));
  });
  setInterval(() => {
    const out = [...bots.entries()].map(([id, b]) => ({ id, ...b }));
    parentPort!.postMessage({ bots: out, lagMax });
    lagMax = 0;
  }, 1000);
}

// ------------------------------------------------------------------------------------------------ orchestrator

interface Summary {
  worlds: { world: number; online: number; lastTick: number; ticksPerSec: number; snapshotsAccepted: number; snapshotsRejected: number; snapshotBytes: number; snapshotTick: number; lastVerifyMs: number; hashFails: number; resyncs: number; held: boolean }[];
  process: { rssMb: number; heapMb: number; lagP99Ms: number; uptimeS: number; dbBytes?: number; walBytes?: number };
}

const base = `http://127.0.0.1:${PORT}`;
const sh = (...a: string[]) => execFileSync(a[0], a.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cg = (f: string) => Number(sh("docker", "exec", NAME, "cat", `/sys/fs/cgroup/${f}`));
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Docker container removal by its one literal name, used on every exit path (CLAUDE.md: no rm/cleanup on a
 * variable or glob — this is the one literal name this whole script ever passes to `docker rm`). */
const removeContainer = () => {
  try {
    sh("docker", "rm", "-f", NAME);
  } catch {
    /* already gone */
  }
};

async function getSummary(): Promise<{ s: Summary; ms: number }> {
  const t = performance.now();
  const s = (await (await fetch(`${base}/api/summary`)).json()) as Summary;
  return { s, ms: performance.now() - t };
}

interface CreatedRoom {
  id: number;
  code: string;
  cfg: RoomConfig;
}

async function createRoom(mode: string, cfg: RoomConfig, name: string): Promise<CreatedRoom> {
  const r = await fetch(`${base}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ name, mode, config: Buffer.from(encodeConfig(cfg)).toString("base64"), visibility: "public" }),
  });
  if (r.status !== 201) throw new Error(`create room ${mode} failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { id: number; code: string };
  return { id: body.id, code: body.code, cfg };
}

async function main() {
  const holdS = Number(process.env.HOLD_S ?? 30);
  const out = process.env.OUT ?? "docs/research/capacity-rooms-results.json";
  const results: Record<string, unknown> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const run: Record<string, unknown> = { startedAt: new Date().toISOString(), holdS, botsPerRoom: BOTS_PER_ROOM };
  results[runId] = run;
  const save = () => writeFileSync(out, JSON.stringify(results, null, 1));

  removeContainer();
  sh("docker", "run", "-d", "--name", NAME, "--init", "--memory=256m", "--memory-swap=256m", "--cpus=1", "-p", `${PORT}:8080`, "-e", "PORT=8080", "--tmpfs", "/data", "app");
  for (let i = 0; i < 60; i++) {
    try {
      await getSummary();
      break;
    } catch {
      await sleep(500);
    }
  }

  // Baseline: idle, fresh DB, before any room exists.
  await sleep(5_000);
  const b = await getSummary();
  run.baseline = { rssMbSummary: b.s.process.rssMb, cgroupMemMb: r2(cg("memory.current") / 1048576) };
  save();

  // Room mix: 2 Caves-preset (deathmatch) rooms at size M, 2 Caves-preset (deathmatch) rooms at size S. Caves
  // (not Solid-box/Creative) chosen because the Pos-sending avatar path is the real per-tick, per-member cost
  // this bench wants to measure (as capacity.ts's existing cave-world bots do) — a Creative/painter room's
  // Paint traffic is already measured in the pre-R2 two-fixed-world bench and this slice isn't re-covering it.
  // Two M (not L) chosen per the brief's note 3: an L room is a 2-slot weight against MAX_LOADED_ROOMS=16 and
  // the point here is measuring 24 members' memory/CPU cost, not exercising the cap logic (R2b's tests do that).
  // avatars field is forced to 1 (game-mode) regardless of preset default so every room is a real playable
  // avatar world a Pos-sending bot can join.
  const sizeM: RoomConfig = { ...CAVES_PVP, size: 1, avatars: 1, maxPlayers: 8 };
  const sizeS: RoomConfig = { ...CAVES_PVP, size: 0, avatars: 1, maxPlayers: 8 };
  const roomSpecs: { mode: string; cfg: RoomConfig; name: string }[] = [
    { mode: "deathmatch", cfg: sizeM, name: "R2c cave M #1" },
    { mode: "deathmatch", cfg: sizeM, name: "R2c cave M #2" },
    { mode: "deathmatch", cfg: sizeS, name: "R2c cave S #1" },
    { mode: "deathmatch", cfg: sizeS, name: "R2c cave S #2" },
  ];
  const rooms: CreatedRoom[] = [];
  for (const spec of roomSpecs) rooms.push(await createRoom(spec.mode, spec.cfg, spec.name));
  run.rooms = rooms.map((r) => ({ id: r.id, code: r.code, size: r.cfg.size }));
  save();

  const wasm = new Uint8Array(await (await fetch(`${base}/sim.wasm`)).arrayBuffer());
  const hashHex = await simBuildHash(wasm);
  const workers: Worker[] = [];
  const latest: { bots: (BotCounters & { id: number })[]; lagMax: number }[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { wasm, hashHex } });
    w.on("message", (m) => (latest[i] = m));
    w.on("error", (e) => console.error("worker error", e));
    workers.push(w);
  }
  const allBots = () => latest.flatMap((l) => l?.bots ?? []);
  let nextId = 0;
  const ipFor = (id: number) => `10.9.${id >> 8}.${(id & 255) + 1}`;
  const register = async (name: string) => {
    for (;;) {
      const r = await fetch(`${base}/api/players`, { method: "POST", body: JSON.stringify({ display_name: name }) });
      if (r.status === 200) return ((await r.json()) as { token: string }).token;
      if (r.status === 429) {
        await sleep(2000);
        continue;
      }
      throw new Error(`register ${r.status}`);
    }
  };
  const addBot = async (roomId: number) => {
    const id = nextId++;
    const token = await register(`cap${id}`);
    await sleep(1050); // registration is capped at 60 a minute, same pattern as capacity.ts
    workers[id % WORKERS].postMessage({ cmd: "add", id, room: roomId, token, ip: ipFor(id) });
  };

  // 24 sockets over 4 real rooms: 6 bots per room, rooms filled one at a time.
  for (const r of rooms) for (let i = 0; i < BOTS_PER_ROOM; i++) await addBot(r.id);

  const joinDeadline = Date.now() + 120_000;
  let s0 = (await getSummary()).s;
  const onlineInRooms = (s: Summary) => rooms.reduce((n, r) => n + (s.worlds.find((w) => w.world === r.id)?.online ?? 0), 0);
  while (Date.now() < joinDeadline && onlineInRooms(s0) < 24) {
    await sleep(1000);
    s0 = (await getSummary()).s;
  }
  const joinedAll = onlineInRooms(s0) === 24;

  // Settle, then hold briefly before forcing a verify.
  await sleep(Math.min(10, holdS / 3) * 1000);

  // Force a verify in every room. World.requestSnapshot() is not reachable from outside the process today
  // (see "Architectural decisions for review" in the report) — ADMIN_TOKEN is set for this container and
  // POST /api/admin/reset is the one existing, already-shipped route that can reach a World by id without a
  // new route; it is NOT used here (a reset would destroy the very state being measured). Instead this bench
  // drives a forced verify the less invasive way the brief allows: it waits out a full natural snapshot cycle
  // (SNAPSHOT_EVERY_TICKS = 1800 ticks @ 60 Hz = 30 s) rather than adding a debug endpoint, since the existing
  // capacity.ts bench already relies on exactly this natural-cycle wait and no server route exists today that
  // reaches World.requestSnapshot() from HTTP.
  const verifyDeadline = Date.now() + 75_000;
  const sAcceptedAtJoin = new Map(rooms.map((r) => [r.id, s0.worlds.find((w) => w.world === r.id)?.snapshotsAccepted ?? 0]));
  let sV = s0;
  const allVerified = () => rooms.every((r) => (sV.worlds.find((w) => w.world === r.id)?.snapshotsAccepted ?? 0) > (sAcceptedAtJoin.get(r.id) ?? 0));
  while (Date.now() < verifyDeadline && !allVerified()) {
    await sleep(1000);
    sV = (await getSummary()).s;
  }
  const verified = allVerified();

  // Measurement point: 24 sockets, post-verify (or post-deadline if a room never got a natural cycle in time).
  const cgroupMemMbPostVerify = r2(cg("memory.current") / 1048576);
  const cgroupMemMbPeak = r2(cg("memory.peak") / 1048576);
  const sFinal = (await getSummary()).s;
  const perRoom = rooms.map((r) => {
    const w = sFinal.worlds.find((x) => x.world === r.id)!;
    return {
      room: r.id,
      size: r.cfg.size,
      online: w.online,
      ticksPerSec: w.ticksPerSec,
      snapshotsAccepted: w.snapshotsAccepted,
      snapshotsRejected: w.snapshotsRejected,
      snapshotBytes: w.snapshotBytes,
      lastVerifyMs: w.lastVerifyMs,
      hashFails: w.hashFails,
      resyncs: w.resyncs,
    };
  });
  const bots1 = allBots();
  const resultRun = {
    joinedAll,
    verified,
    onlineTotal: onlineInRooms(sFinal),
    rssMbLast: sFinal.process.rssMb,
    cgroupMemMbPostVerify,
    cgroupMemMbPeak,
    passUnder200MB: cgroupMemMbPostVerify < 200,
    perRoom,
    botsClosed: bots1.filter((x) => x.closed).length,
    botRejects: bots1.filter((x) => x.rejected).map((x) => x.rejected).slice(0, 5),
    finishedAt: new Date().toISOString(),
  };
  Object.assign(run, resultRun);
  save();
  console.log(JSON.stringify(resultRun, null, 1));

  for (const w of workers) await w.terminate();
  removeContainer();
  process.exit(0);
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    removeContainer();
    process.exit(1);
  });
}
