// Capacity bench: how much of one Fly shared-cpu-1x machine (256 MB) do members cost? A script, not a test:
// `pnpm soak:capacity`. Run `docker build -t app .` first. It starts the real image as `cap-bench` with the Fly
// memory limit, adds headless bots in steps (half in world 0, half in world 1), holds each step, and records raw
// numbers to docs/research/capacity-results.json under the key `cpus<C>`.
//
// Bots are headless Node clients running the REAL client code (Lockstep, reactToTick, shared protocol), each with a
// full WASM sim: they hash, answer snapshot requests and send LIVE like the browser worker. They run in worker
// threads so bot CPU does not starve the sampler. World 0 bots Paint ~20/s; world 1 bots send Pos ~30/s (the real
// rate; no casts). Every bot sets a distinct Fly-Client-IP header (the server trusts it) so the 12-per-IP cap, which
// would otherwise bind on one host, does not.
//
// Env: CPUS (default 1), STEPS (default 0,8,16,32,48,64), HOLD_S (default 60), PORT (default 8094), OUT.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import WebSocket from "ws";
import { Lockstep, reactToTick } from "../../client/lockstep.ts";
import { encodePaint, encodePos, KIND_PAINT, KIND_POS, unhex } from "../../shared/inputs.ts";
import { decodeServer, encodeHash, encodeHello, encodeInput, encodeLive, encodePing, encodeSnapshotUpload } from "../../shared/protocol.ts";
import { loadSim, simBuildHash, type Sim } from "../../shared/sim.ts";

const PORT = Number(process.env.PORT ?? 8094);
const NAME = "cap-bench";
const WORKERS = 4;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------- bot (worker)

interface BotCounters {
  world: number;
  bytes: number;
  frames: number;
  opened: boolean;
  closed: boolean;
  hashes: number;
  snaps: number;
  resyncs: number;
  rejected: string;
}

function startBot(wasm: Uint8Array, hashHex: string, id: number, world: number, token: Uint8Array, ip: string): BotCounters {
  const c: BotCounters = { world, bytes: 0, frames: 0, opened: false, closed: false, hashes: 0, snaps: 0, resyncs: 0, rejected: "" };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { "fly-client-ip": ip } });
  ws.binaryType = "nodebuffer";
  let ls: Lockstep | null = null;
  let seq = 0;
  let playerId = 0;
  let seed = 0n;
  let kind = 0;
  let liveSent = false;
  let wantSnapshotAt = 0;
  let ent = { x: 0, y: 0, life: 0, ok: false };
  let flip = 0;
  const timers: NodeJS.Timeout[] = [];

  const begin = (target: number) => {
    const sim: Sim = loadSim(wasm);
    sim.init(seed, kind);
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
    liveSent = false;
    ent.ok = false;
  };
  const maybeLive = () => {
    if (ls && !liveSent && !ls.fastForwarding && ws.readyState === WebSocket.OPEN) {
      liveSent = true;
      ws.send(encodeLive(ls.sim.tick()));
    }
  };

  ws.on("open", () => {
    c.opened = true;
    ws.send(encodeHello(unhex(hashHex), world, token));
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
        kind = m.worldKind;
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
    if (world === 1) {
      // Re-read the avatar's place twice a second; send a Pos every 33 ms (about 30/s) with a one-unit wiggle.
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
    } else {
      timers.push(
        setInterval(() => {
          if (!ls || ls.fastForwarding || ws.readyState !== WebSocket.OPEN) return;
          const x = 20 + Math.floor(Math.random() * 400);
          const y = 20 + Math.floor(Math.random() * 400);
          ws.send(encodeInput(++seq, KIND_PAINT, encodePaint(0, 1 + (id % 6), x, y, x + 40, y + 5, 6).subarray(5)));
        }, 50),
      );
    }
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
  parentPort!.on("message", (m: { cmd: string; id: number; world: number; token: string; ip: string }) => {
    if (m.cmd === "add") bots.set(m.id, startBot(wasm, hashHex, m.id, m.world, unhex(m.token), m.ip));
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
const cpuUsec = () => Number(/usage_usec (\d+)/.exec(sh("docker", "exec", NAME, "cat", "/sys/fs/cgroup/cpu.stat"))![1]);
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function getSummary(): Promise<{ s: Summary; ms: number }> {
  const t = performance.now();
  const s = (await (await fetch(`${base}/api/summary`)).json()) as Summary;
  return { s, ms: performance.now() - t };
}

async function main() {
  const cpus = process.env.CPUS ?? "1";
  const steps = (process.env.STEPS ?? "0,8,16,32,48,64").split(",").map(Number);
  const holdS = Number(process.env.HOLD_S ?? 60);
  const out = process.env.OUT ?? "docs/research/capacity-results.json";
  const results: Record<string, unknown> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};

  try { sh("docker", "rm", "-f", NAME); } catch { /* none */ }
  sh("docker", "run", "-d", "--name", NAME, "--init", "--memory=256m", "--memory-swap=256m", `--cpus=${cpus}`, "-p", `${PORT}:8080`, "-e", "PORT=8080", "--tmpfs", "/data", "app");
  for (let i = 0; i < 60; i++) {
    try { await getSummary(); break; } catch { await sleep(500); }
  }
  const run: Record<string, unknown> = { cpus, startedAt: new Date().toISOString(), holdS, steps: [] as unknown[] };
  results[`cpus${cpus}`] = run;
  const save = () => writeFileSync(out, JSON.stringify(results, null, 1));

  // Baseline: idle, fresh DB.
  await sleep(10_000);
  const b = await getSummary();
  run.baseline = { rssMbSummary: b.s.process.rssMb, heapMb: b.s.process.heapMb, cgroupMemMb: r2(cg("memory.current") / 1048576), dockerStats: sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}}", NAME), uptimeS: b.s.process.uptimeS };
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
      if (r.status === 429) { await sleep(2000); continue; }
      throw new Error(`register ${r.status}`);
    }
  };
  const addBot = async (world: number) => {
    const id = nextId++;
    const token = world === 1 ? await register(`cap${id}`) : "00".repeat(32);
    if (world === 1) await sleep(1050); // registration is capped at 60 a minute
    workers[id % WORKERS].postMessage({ cmd: "add", id, world, token, ip: ipFor(id) });
  };

  for (const target of steps) {
    // Alternate worlds (world 0 first), so each step is half and half.
    while (nextId < target) await addBot(nextId % 2);
    const joinDeadline = Date.now() + 120_000;
    let s0 = (await getSummary()).s;
    while (Date.now() < joinDeadline && (s0.worlds[0].online + s0.worlds[1].online < target || s0.worlds.some((w) => w.held))) {
      await sleep(1000);
      s0 = (await getSummary()).s;
    }
    const joinedAll = s0.worlds[0].online + s0.worlds[1].online === target;
    // Hold, sampling at about 4 Hz. The first part is settling (catch-up replays); the rest is the window.
    const settleS = Math.min(15, holdS / 4);
    await sleep(settleS * 1000);
    const t0 = performance.now();
    const w0 = await getSummary();
    const bytes0 = allBots().map((x) => ({ ...x }));
    const cpu0 = cpuUsec();
    const samples: { t: number; rss: number; lag: number; rtt: number; tps: number[]; acc: number[] }[] = [];
    while (performance.now() - t0 < (holdS - settleS) * 1000) {
      const { s, ms } = await getSummary();
      samples.push({ t: performance.now() - t0, rss: s.process.rssMb, lag: s.process.lagP99Ms, rtt: ms, tps: s.worlds.map((w) => w.ticksPerSec), acc: s.worlds.map((w) => w.snapshotsAccepted) });
      await sleep(250);
    }
    const t1 = performance.now();
    const w1 = await getSummary();
    const cpu1 = cpuUsec();
    const bots1 = allBots();
    const dt = (t1 - t0) / 1000;
    const perWorld = [0, 1].map((wi) => {
      const mine = bots1.filter((x) => x.world === wi);
      const members = mine.filter((x) => !x.closed).length;
      const dBytes = mine.reduce((a, x) => a + x.bytes - (bytes0.find((y) => y.id === x.id)?.bytes ?? 0), 0);
      const dFrames = mine.reduce((a, x) => a + x.frames - (bytes0.find((y) => y.id === x.id)?.frames ?? 0), 0);
      const a = w0.s.worlds[wi];
      const z = w1.s.worlds[wi];
      return {
        world: wi,
        members,
        closedTicksPerSec: r2((z.lastTick - a.lastTick) / dt),
        summaryTicksPerSecMin: pct(samples.map((x) => x.tps[wi]), 0),
        summaryTicksPerSecMean: r2(mean(samples.map((x) => x.tps[wi]))),
        outBytesPerMemberPerSec: members ? Math.round(dBytes / dt / members) : 0,
        outFramesPerMemberPerSec: members ? r2(dFrames / dt / members) : 0,
        snapshotsAcceptedDelta: z.snapshotsAccepted - a.snapshotsAccepted,
        snapshotsRejected: z.snapshotsRejected,
        snapshotBytes: z.snapshotBytes,
        lastVerifyMs: z.lastVerifyMs,
        hashFails: z.hashFails,
        resyncs: z.resyncs,
      };
    });
    // Max RSS in the six samples before each accepted snapshot (the verify finishes just before the count rises).
    const rssNearAccept = (wi: number) => {
      const peaks: number[] = [];
      for (let i = 1; i < samples.length; i++) if (samples[i].acc[wi] > samples[i - 1].acc[wi]) peaks.push(Math.max(...samples.slice(Math.max(0, i - 6), i + 1).map((x) => x.rss)));
      return peaks;
    };
    const stepRes = {
      target,
      joinedAll,
      online: w1.s.worlds.map((w) => w.online),
      windowS: r2(dt),
      rssMbMean: r2(mean(samples.map((x) => x.rss))),
      rssMbMax: Math.max(0, ...samples.map((x) => x.rss)),
      rssMbLast: w1.s.process.rssMb,
      cgroupMemMbNow: r2(cg("memory.current") / 1048576),
      cgroupMemMbPeakCumulative: r2(cg("memory.peak") / 1048576),
      lagP99MsMax: Math.max(0, ...samples.map((x) => x.lag)),
      lagP99MsLast: w1.s.process.lagP99Ms,
      lagP99Note: "server histogram resets once a minute (process.minute), so values are since the last reset",
      httpRttMsP50: r2(pct(samples.map((x) => x.rtt), 0.5)),
      httpRttMsP99: r2(pct(samples.map((x) => x.rtt), 0.99)),
      containerCpuCores: r2((cpu1 - cpu0) / 1e6 / dt),
      perWorld,
      rssAtWorld1Accepts: rssNearAccept(1),
      rssAtWorld0Accepts: rssNearAccept(0),
      botsClosed: bots1.filter((x) => x.closed).length,
      botRejects: bots1.filter((x) => x.rejected).map((x) => x.rejected).slice(0, 3),
      botLoopLagMaxMs: Math.max(0, ...latest.map((l) => Math.round(l?.lagMax ?? 0))),
      botUploads: bots1.reduce((a, x) => a + x.snaps, 0),
      dockerStats: sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}}", NAME),
    };
    (run.steps as unknown[]).push(stepRes);
    save();
    console.log(JSON.stringify({ target, online: stepRes.online, rssMax: stepRes.rssMbMax, lagMax: stepRes.lagP99MsMax, tps: perWorld.map((p) => p.closedTicksPerSec), cpu: stepRes.containerCpuCores }));
  }

  // Disk and OOM. The DB is read inside the container with node:sqlite, read-only.
  const q = `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/game.db",{readOnly:true});
const o={snap:d.prepare("select world_id w,count(*) n,sum(length(data)) b,max(length(data)) mx from snapshots group by world_id").all(),
log:d.prepare("select world_id w,count(*) n,sum(length(data)) b from tick_log group by world_id").all()};console.log(JSON.stringify(o));`;
  try { run.disk = JSON.parse(sh("docker", "exec", NAME, "node", "-e", q)); } catch (e) { run.disk = { error: String(e).slice(0, 200) }; }
  try { run.dataDir = sh("docker", "exec", NAME, "sh", "-c", "du -sb /data/* | cat"); } catch { /* ignore */ }
  run.oomKilled = sh("docker", "inspect", NAME, "--format", "{{.State.OOMKilled}}");
  run.finishedAt = new Date().toISOString();
  save();
  for (const w of workers) await w.terminate();
  try { sh("docker", "rm", "-f", NAME); } catch { /* ignore */ }
  process.exit(0);
}

if (isMainThread) main().catch((e) => { console.error(e); try { sh("docker", "rm", "-f", NAME); } catch { /* ignore */ } process.exit(1); });
