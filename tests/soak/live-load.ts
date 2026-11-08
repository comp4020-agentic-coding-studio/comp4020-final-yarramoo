// Live load test (9 Nov): the capacity-ramp bot, unchanged except that it connects to the live site over wss://
// with no spoofed fly-client-ip (Fly sets the real one, so the per-IP caps apply: 12 sockets, 10 room creates/hour).
// `node tests/soak/live-load.ts`; env ROOMS (default 3), BOTS (default 4), HOLD_S (default 180), OUT.
import { writeFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import WebSocket from "ws";
import { Lockstep, reactToTick } from "../../client/lockstep.ts";
import { encodeCast, encodePos, encodeReady, KIND_CAST, KIND_POS, KIND_READY, unhex } from "../../shared/inputs.ts";
import { encodeConfig, SURVIVAL, type RoomConfig } from "../../shared/room.ts";
import { CLAIM_KILL, CLAIM_ROUND_END, CLAIM_ROUND_START, decodeServer, encodeClaim, encodeClaimEvent, encodeHash, encodeHello, encodeInput, encodeLive, encodePing, encodeSnapshotUpload } from "../../shared/protocol.ts";
import { ENT_PLAYER, EV_DEATH, EV_ENEMY_DEATH, EV_ROUND_END, EV_ROUND_START, loadSim, simBuildHash, type Sim } from "../../shared/sim.ts";

const HOST = process.env.HOST ?? "comp4020-final-yarramoo.fly.dev";
const WORKERS = 3;
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

function startBot(wasm: Uint8Array, hashHex: string, id: number, room: number, token: Uint8Array, ip: string, survival: boolean): BotCounters {
  const c: BotCounters = { room, bytes: 0, frames: 0, opened: false, closed: false, hashes: 0, snaps: 0, resyncs: 0, rejected: "" };
  void ip;
  const ws = new WebSocket(`wss://${HOST}/ws`);
  ws.binaryType = "nodebuffer";
  let ls: Lockstep | null = null;
  let seq = 0;
  let playerId = 0;
  let seed = 0n;
  let cfg: Uint8Array = new Uint8Array(0);
  let wantSnapshotAt = 0;
  let ent = { x: 0, y: 0, life: 0, ok: false };
  let flip = 0;
  let readySent = false;
  let roundEnds = 0;
  let castSeq = 0;
  const timers: NodeJS.Timeout[] = [];

  const begin = (target: number) => {
    const sim: Sim = loadSim(wasm);
    sim.init(seed, cfg);
    ls = new Lockstep(sim);
    ls.catchUpTarget = target;
    ls.onStepped = (tick) => {
      if (!ls || ws.readyState !== WebSocket.OPEN) return;
      const r = reactToTick(ls, tick, wantSnapshotAt);
      // Claims (reports, never inputs) exactly as client/worker.ts:331-345 sends them; the server needs a majority
      // CLAIM_ROUND_START before /api/summary round turns "running".
      if (tick > ls.catchUpTarget && !ls.fastForwarding) {
        for (const e of ls.sim.events()) {
          if (e.kind === EV_DEATH) ws.send(encodeClaim(tick, e.player, e.a, e.b, e.c));
          else if (e.kind === EV_ENEMY_DEATH) ws.send(encodeClaimEvent(CLAIM_KILL, tick, e.player, e.a, e.b, e.c));
          else if (e.kind === EV_ROUND_START) ws.send(encodeClaimEvent(CLAIM_ROUND_START, tick, e.a, 0, 0, 0));
          else if (e.kind === EV_ROUND_END) {
            const players = ls.sim.entities().filter((q) => q.type === ENT_PLAYER);
            roundEnds++;
            ws.send(encodeClaimEvent(CLAIM_ROUND_END, tick, e.a, players.length, 0, 0, players.filter((q) => q.health > 0).map((q) => q.id).sort((x, y) => x - y)));
          }
        }
      }
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
        if (survival && !readySent && liveSent) {
          readySent = true;
          ws.send(encodeInput(++seq, KIND_READY, encodeReady(0, 1).subarray(5)));
        }
      }, 33),
    );
    // One Cast about every 2 s (jittered start so bots do not all cast on the same tick). May be refused by the sim.
    timers.push(
      setInterval(() => {
        if (!ent.ok || !ls || ls.fastForwarding || ws.readyState !== WebSocket.OPEN) return;
        castSeq = (castSeq + 1) & 0xffff;
        ws.send(encodeInput(++seq, KIND_CAST, encodeCast(0, 0, (castSeq * 997) & 0xffff, castSeq).subarray(5)));
      }, 2000 + (id % 10) * 20),
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
  parentPort!.on("message", (m: { cmd: string; id: number; room: number; token: string; ip: string; survival: boolean }) => {
    if (m.cmd === "add") bots.set(m.id, startBot(wasm, hashHex, m.id, m.room, unhex(m.token), m.ip, m.survival));
  });
  setInterval(() => {
    const out = [...bots.entries()].map(([id, b]) => ({ id, ...b }));
    parentPort!.postMessage({ bots: out, lagMax });
    lagMax = 0;
  }, 1000);
}

// ------------------------------------------------------------------------------------------------ orchestrator

interface WorldSum { world: number; online: number; lastTick: number; ticksPerSec: number; snapshotsAccepted: number; snapshotsRejected: number; lastVerifyMs: number; hashFails: number; resyncs: number; held: boolean; round?: string | null }
interface Summary { worlds: WorldSum[]; process: { rssMb: number; heapMb: number; lagP99Ms: number; uptimeS: number } }

if (isMainThread) {
  const base = `https://${HOST}`;
  const ROOMS = Number(process.env.ROOMS ?? 3);
  const BOTS = Number(process.env.BOTS ?? 4);
  const HOLD_S = Number(process.env.HOLD_S ?? 180);
  const OUT = process.env.OUT ?? "docs/research/live-load-2026-11-09.json";
  const summary = async (): Promise<Summary> => (await (await fetch(`${base}/api/summary`, { signal: AbortSignal.timeout(20_000) })).json()) as Summary;
  const wasm = new Uint8Array(await (await fetch(`${base}/sim.wasm`)).arrayBuffer());
  const hashHex = await simBuildHash(wasm);
  const workers = Array.from({ length: WORKERS }, () => new Worker(new URL(import.meta.url), { workerData: { wasm, hashHex } }));
  const latest = new Map<number, { bots: (BotCounters & { id: number })[]; lagMax: number }>();
  workers.forEach((w, i) => w.on("message", (m) => latest.set(i, m)));
  const rooms: number[] = [];
  for (let r = 0; r < ROOMS; r++) {
    const res = await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ name: `load test ${r + 1}`, mode: "survival", config: Buffer.from(encodeConfig({ ...SURVIVAL })).toString("base64"), visibility: "unlisted" }) });
    if (res.status !== 201) throw new Error(`create room: ${res.status} ${await res.text()}`);
    rooms.push(((await res.json()) as { id: number }).id);
  }
  let id = 0;
  for (const room of rooms) for (let b = 0; b < BOTS; b++) {
    const reg = await fetch(`${base}/api/players`, { method: "POST", body: JSON.stringify({ display_name: `Loadbot${++id}` }) });
    if (reg.status !== 200 && reg.status !== 201) throw new Error(`register: ${reg.status}`);
    const token = ((await reg.json()) as { token: string }).token;
    workers[id % WORKERS].postMessage({ cmd: "add", id, room, token, ip: "", survival: true });
    await sleep(400);
  }
  const samples: unknown[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < HOLD_S * 1000) {
    await sleep(10_000);
    const s = await summary().catch(() => null);
    const bots = [...latest.values()].flatMap((v) => v.bots);
    const mine = s?.worlds.filter((w) => rooms.includes(w.world)) ?? [];
    const sample = {
      t: Math.round((performance.now() - t0) / 1000),
      open: bots.filter((b) => b.opened && !b.closed).length, rejected: bots.filter((b) => b.rejected).map((b) => b.rejected),
      hashes: bots.reduce((a, b) => a + b.hashes, 0), resyncs: bots.reduce((a, b) => a + b.resyncs, 0), snaps: bots.reduce((a, b) => a + b.snaps, 0),
      rooms: mine.map((w) => ({ world: w.world, online: w.online, tps: w.ticksPerSec, hashFails: w.hashFails, resyncs: w.resyncs, snapOk: w.snapshotsAccepted, snapRej: w.snapshotsRejected, verifyMs: w.lastVerifyMs, round: w.round })),
      server: s?.process, botLagMaxMs: Math.max(0, ...[...latest.values()].map((v) => v.lagMax)),
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
    writeFileSync(OUT, JSON.stringify({ host: HOST, rooms, bots: ROOMS * BOTS, holdS: HOLD_S, samples }, null, 1));
  }
  for (const w of workers) await w.terminate();
  process.exit(0);
}
