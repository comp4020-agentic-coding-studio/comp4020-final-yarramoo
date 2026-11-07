// (capacity-ramp.ts: 7 Nov steady-state ramp in rooms, Survival M x4 bots / Deathmatch M x8 bots, casts, ready-up.)
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
import { encodeCast, encodePos, encodeReady, KIND_CAST, KIND_POS, KIND_READY, unhex } from "../../shared/inputs.ts";
import { encodeConfig, SURVIVAL, type RoomConfig } from "../../shared/room.ts";
import { CLAIM_KILL, CLAIM_ROUND_END, CLAIM_ROUND_START, decodeServer, encodeClaim, encodeClaimEvent, encodeHash, encodeHello, encodeInput, encodeLive, encodePing, encodeSnapshotUpload } from "../../shared/protocol.ts";
import { ENT_PLAYER, EV_DEATH, EV_ENEMY_DEATH, EV_ROUND_END, EV_ROUND_START, loadSim, simBuildHash, type Sim } from "../../shared/sim.ts";

const PORT = Number(process.env.PORT ?? 8094);
const NAME = "cap-bench-rooms";
const IMAGE = process.env.IMAGE ?? "cap-app:9cfd24f";
const WORKERS = 4;
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
//
// `pnpm tsx tests/soak/capacity-ramp.ts --scenario A|B --cpus 1|0.0625 [--idle]`; env PORT, IMAGE, OUT, SETTLE_S, WINDOW_S.
// Scenario A: Survival M (SURVIVAL preset), 4 bots/room, rooms 1,2,4,6. Scenario B: Deathmatch M, 8 bots/room, rooms 1,2,3,4.

interface WorldSum {
  world: number; online: number; lastTick: number; ticksPerSec: number; snapshotsAccepted: number; snapshotsRejected: number;
  snapshotBytes: number; snapshotTick: number; lastVerifyMs: number; hashFails: number; resyncs: number; held: boolean;
  round?: string | null;
}
interface Summary {
  worlds: WorldSum[];
  process: { rssMb: number; heapMb: number; lagP99Ms: number; uptimeS: number; dbBytes?: number; walBytes?: number };
}

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const base = `http://127.0.0.1:${PORT}`;
const sh = (...a: string[]) => execFileSync(a[0], a.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cgRead = (f: string) => sh("docker", "exec", NAME, "cat", `/sys/fs/cgroup/${f}`);
const cgNum = (f: string) => Number(cgRead(f));
const cpuStat = () => {
  const o: Record<string, number> = {};
  for (const l of cgRead("cpu.stat").split("\n")) {
    const [k, v] = l.split(" ");
    if (k) o[k] = Number(v);
  }
  return o;
};
let summaryRetries = 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const removeContainer = () => {
  try {
    sh("docker", "rm", "-f", NAME);
  } catch {
    /* already gone */
  }
};

async function getSummary(): Promise<{ s: Summary; ms: number }> {
  // Under a tiny CPU quota the server can be too slow to answer (or drop the keep-alive socket): retry, and count it.
  const t = performance.now();
  for (let i = 0; ; i++) {
    try {
      const s = (await (await fetch(`${base}/api/summary`, { signal: AbortSignal.timeout(20_000) })).json()) as Summary;
      return { s, ms: performance.now() - t };
    } catch (e) {
      summaryRetries++;
      if (i >= 30) throw e;
      await sleep(500);
    }
  }
}

async function createRoom(mode: string, cfg: RoomConfig, name: string, n: number): Promise<number> {
  const r = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "fly-client-ip": `10.8.0.${n}` },
    body: JSON.stringify({ name, mode, config: Buffer.from(encodeConfig(cfg)).toString("base64"), visibility: "public" }),
  });
  if (r.status !== 201) throw new Error(`create room ${mode} failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: number }).id;
}

const DEATHMATCH: RoomConfig = { terrain: 0, size: 1, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 0, respawnSecs: 3, pickupRespawn: 1, round: 0, maxPlayers: 8, enemies: 0 };

async function main() {
  const scenario = (arg("scenario", "A") ?? "A").toUpperCase();
  const cpus = arg("cpus", "1")!;
  const idleToo = process.argv.includes("--idle");
  const survival = scenario === "A";
  const botsPerRoom = Number(process.env.BOTS ?? (survival ? 4 : 8)); // BOTS overrides the room size (lead: the 2-player floor at the quota)
  const steps = (survival ? [1, 2, 4, 6] : [1, 2, 3, 4]).slice(0, Number(process.env.MAXSTEPS ?? 99));
  const mode = survival ? "survival" : "deathmatch";
  const cfg = survival ? { ...SURVIVAL } : DEATHMATCH;
  const settleS = Number(process.env.SETTLE_S ?? 15);
  const windowS = Number(process.env.WINDOW_S ?? 45);
  const out = process.env.OUT ?? "docs/research/capacity-2026-11-07-bench.json";
  const results: Record<string, unknown> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  const runId = `${scenario}_cpus${cpus}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const run: Record<string, unknown> = { startedAt: new Date().toISOString(), scenario, mode, cpus, botsPerRoom, image: IMAGE, hostLoadBefore: sh("uptime"), steps: [] };
  results[runId] = run;
  const save = () => writeFileSync(out, JSON.stringify(results, null, 1));

  removeContainer();
  sh("docker", "run", "-d", "--name", NAME, "--init", "--memory=256m", "--memory-swap=256m", `--cpus=${cpus}`, "-p", `${PORT}:8080`, "-e", "PORT=8080", "--tmpfs", "/data", IMAGE);
  for (let i = 0; i < 60; i++) {
    try {
      await getSummary();
      break;
    } catch {
      await sleep(500);
    }
  }
  await sleep(5_000);
  if (idleToo) {
    const c0 = cpuStat();
    const t0 = performance.now();
    await sleep(30_000);
    const c1 = cpuStat();
    const wall = (performance.now() - t0) / 1000;
    const b = await getSummary();
    run.idle = {
      cpuCores: r4((c1.usage_usec - c0.usage_usec) / 1e6 / wall),
      nrThrottled: c1.nr_throttled - c0.nr_throttled,
      cgroupMemMb: r2(cgNum("memory.current") / 1048576),
      rssMbSummary: b.s.process.rssMb,
    };
    save();
    console.log("idle", JSON.stringify(run.idle));
  }

  const wasm = new Uint8Array(await (await fetch(`${base}/sim.wasm`)).arrayBuffer());
  const hashHex = await simBuildHash(wasm);
  const workers: Worker[] = [];
  const latest: { bots: (BotCounters & { id: number })[]; lagMax: number }[] = [];
  const lagMaxSeen = new Array(WORKERS).fill(0);
  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { wasm, hashHex } });
    w.on("message", (m) => {
      latest[i] = m;
      lagMaxSeen[i] = Math.max(lagMaxSeen[i], m.lagMax);
    });
    w.on("error", (e) => console.error("worker error", e));
    workers.push(w);
  }
  const allBots = () => latest.flatMap((l) => l?.bots ?? []);
  let nextId = 0;
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
    await sleep(1050);
    workers[id % WORKERS].postMessage({ cmd: "add", id, room: roomId, token, ip: `10.9.${id >> 8}.${(id & 255) + 1}`, survival });
  };

  const roomIds: number[] = [];
  let roomN = 0;
  let failedAt = -1;
  let roundsEnded = 0;
  const lastRound = new Map<number, string>();
  const diag: string[] = [];

  for (let si = 0; si < steps.length; si++) {
    const target = steps[si];
    while (roomIds.length < target) roomIds.push(await createRoom(mode, cfg, `ramp ${scenario} #${roomIds.length + 1}`, ++roomN));
    const newRooms = roomIds.slice(si === 0 ? 0 : steps[si - 1]);
    for (const id of newRooms) for (let i = 0; i < botsPerRoom; i++) await addBot(id);
    const members = roomIds.length * botsPerRoom;
    const online = (s: Summary) => roomIds.reduce((n, id) => n + (s.worlds.find((w) => w.world === id)?.online ?? 0), 0);
    const joinDeadline = Date.now() + 120_000;
    let s0 = (await getSummary()).s;
    while (Date.now() < joinDeadline && online(s0) < members) {
      await sleep(1000);
      s0 = (await getSummary()).s;
    }
    const joinedAll = online(s0) === members;
    const loadBefore = sh("uptime").replace(/.*load averages?: /, "");
    await sleep(settleS * 1000);

    // Measurement window.
    const sStart = (await getSummary()).s;
    const acc0 = new Map(roomIds.map((id) => [id, sStart.worlds.find((w) => w.world === id)?.snapshotsAccepted ?? 0]));
    const cs0 = cpuStat();
    const bytes0 = allBots().reduce((n, b) => n + b.bytes, 0);
    const tStart = performance.now();
    const memSamples: number[] = [];
    const tps = new Map<number, number[]>(roomIds.map((id) => [id, []]));
    const verifyMs = new Map<number, Set<number>>(roomIds.map((id) => [id, new Set()]));
    const lagSamples: number[] = [];
    const getMs: number[] = [];
    lagMaxSeen.fill(0);
    let sNow = sStart;
    const advancedAll = () => roomIds.every((id) => (sNow.worlds.find((w) => w.world === id)?.snapshotsAccepted ?? 0) > (acc0.get(id) ?? 0));
    let cs1 = cs0;
    let bytes1 = bytes0;
    let tEnd = tStart;
    let extended = false;
    for (let t = 0; ; t++) {
      await sleep(1000);
      const g = await getSummary();
      sNow = g.s;
      getMs.push(g.ms);
      lagSamples.push(sNow.process.lagP99Ms);
      memSamples.push(cgNum("memory.current") / 1048576);
      for (const id of roomIds) {
        const w = sNow.worlds.find((x) => x.world === id);
        if (!w) continue;
        tps.get(id)!.push(w.ticksPerSec);
        verifyMs.get(id)!.add(w.lastVerifyMs);
        if (w.round) {
          const prev = lastRound.get(id);
          if (prev && prev !== "ended" && w.round === "ended") roundsEnded++;
          lastRound.set(id, w.round);
        }
      }
      if (t + 1 >= windowS) {
        // Window closes at windowS, or at the first moment after it all rooms have verified (up to 75 s).
        if (advancedAll() || t + 1 >= 75) {
          extended = t + 1 > windowS;
          cs1 = cpuStat();
          bytes1 = allBots().reduce((n, b) => n + b.bytes, 0);
          tEnd = performance.now();
          break;
        }
      }
    }
    const wall = (tEnd - tStart) / 1000;
    const sEnd = sNow;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const bots = allBots();
    const perRoom = roomIds.map((id) => {
      const w = sEnd.worlds.find((x) => x.world === id)!;
      const tp = tps.get(id)!;
      return {
        room: id, online: w.online, ticksPerSecMin: Math.min(...tp), ticksPerSecMean: r2(mean(tp)), lastVerifyMsSeen: [...verifyMs.get(id)!],
        snapshotsAccepted: w.snapshotsAccepted, snapshotsAcceptedAdvanced: w.snapshotsAccepted - (acc0.get(id) ?? 0), snapshotsRejected: w.snapshotsRejected,
        snapshotBytes: w.snapshotBytes, hashFails: w.hashFails, resyncs: w.resyncs, round: w.round ?? null, held: w.held,
      };
    });
    const step = {
      step: si + 1, rooms: roomIds.length, members, joinedAll, hostLoadBefore: loadBefore, hostLoadAfter: sh("uptime").replace(/.*load averages?: /, ""),
      windowS: r2(wall), windowExtended: extended,
      cpuCores: r4((cs1.usage_usec - cs0.usage_usec) / 1e6 / wall),
      nrThrottled: cs1.nr_throttled - cs0.nr_throttled,
      throttledUsec: cs1.throttled_usec - cs0.throttled_usec,
      nrPeriods: cs1.nr_periods - cs0.nr_periods,
      memMbMean: r2(mean(memSamples)), memMbMax: r2(Math.max(...memSamples)), memPeakMb: r2(cgNum("memory.peak") / 1048576),
      rssMbSummary: sEnd.process.rssMb,
      lagP99MsMax: Math.max(...lagSamples), lagP99MsLast: lagSamples[lagSamples.length - 1],
      summaryRetriesTotal: summaryRetries,
      summaryFetchMsMax: r2(Math.max(...getMs)),
      outBytesPerSecPerMember: r2((bytes1 - bytes0) / wall / members),
      dbBytesStart: sStart.process.dbBytes, dbBytesEnd: sEnd.process.dbBytes, walBytesStart: sStart.process.walBytes, walBytesEnd: sEnd.process.walBytes,
      dbGrowthBytesPerMin: r2(((sEnd.process.dbBytes ?? 0) + (sEnd.process.walBytes ?? 0) - (sStart.process.dbBytes ?? 0) - (sStart.process.walBytes ?? 0)) / (wall / 60)),
      botLagMaxMs: r2(Math.max(...lagMaxSeen)),
      botsClosed: bots.filter((b) => b.closed).length, botRejects: bots.filter((b) => b.rejected).map((b) => b.rejected).slice(0, 5),
      roundsEndedSoFar: roundsEnded,
      perRoom,
    };
    (run.steps as unknown[]).push(step);
    save();
    console.log(JSON.stringify({ ...step, perRoom: perRoom.map((p) => `${p.room}:tps${p.ticksPerSecMin} v${p.lastVerifyMsSeen} acc+${p.snapshotsAcceptedAdvanced} rej${p.snapshotsRejected} ${p.round}`) }, null, 1));

    const fail =
      !joinedAll || step.botsClosed > 0 || perRoom.some((p) => p.ticksPerSecMin < 58 || p.snapshotsRejected > 0 || p.held) || step.lagP99MsMax > 500;
    if (fail && failedAt < 0) {
      failedAt = si;
      diag.push(`first failing step ${si + 1}`);
    }
    if (failedAt >= 0 && si >= failedAt + 1) break;
  }
  run.failedAtStep = failedAt < 0 ? null : failedAt + 1;
  run.finishedAt = new Date().toISOString();
  run.hostLoadAfter = sh("uptime");
  save();
  for (const w of workers) await w.terminate();
  removeContainer();
  process.exit(0);
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    try {
      console.error(sh("docker", "logs", "--tail", "30", NAME));
      console.error(sh("docker", "inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}", NAME));
    } catch {
      /* no container */
    }
    removeContainer();
    process.exit(1);
  });
}
