// Owns the sim, the WebSocket and the playout buffer; steps only through closed ticks from the server,
// and (when it can) renders with WebGL2 into an OffscreenCanvas.
import { KIND_JOIN, KIND_LEAVE, KIND_PAINT, encodePaint } from "../shared/inputs.ts";
import {
  PAINT_PAYLOAD_LEN,
  decodeServer,
  encodeHash,
  encodeHello,
  encodeInput,
  encodePing,
  encodeSnapshotUpload,
} from "../shared/protocol.ts";
import { loadSim, simBuildHash, type Sim } from "../shared/sim.ts";
import { Lockstep, reactToTick } from "./lockstep.ts";
import type { FromWorker, NetState, ToWorker } from "./protocol.ts";
import { Renderer, type Camera } from "./render.ts";

const STEP_MS = 1000 / 60;
const MAX_FRAME_STEPS = 4;
const FF_BUDGET_MS = 12;
const SEND_EVERY_MS = 33; // ~30 paint inputs/s, under the server's 40/s cap
const RECONNECT_MS = [500, 1000, 2000, 4000];

interface WorkerScope {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
}
const ctx = self as unknown as WorkerScope;
const send = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let wasmBytes: Uint8Array;
let buildHash: Uint8Array;
let wsUrl = "";
let renderer: Renderer | null = null;
let sendFrames = false;
let cam: Camera = { x: 0, y: 0, vw: 512, vh: 512 };
// Local single-player mode (dev route ?world=game): no networking, the worker steps its own sim at 60 Hz.
let localSim: Sim | null = null;
const stepTimes: number[] = [];
let ranChunks = 0;

// Per-connection state; discarded on reconnect (the replay rebuilds it).
let ws: WebSocket | null = null;
let ls: Lockstep | null = null;
let myId = 0;
let seedInfo: { seed: bigint; kind: number } | null = null;
let players = 0;
let net: NetState = "connecting";
let attempt = 0;
let inputSeq = 0;
let sentAt: number[] = []; // send times of my paints not yet seen applied
let latencyMs = 0;
let pingMs = 0;
let rejected = "";
let resyncs = 0;
let wantSnapshotAt = 0;

// Paint stroke assembly: a drag sends one segment per SEND_EVERY_MS from the last sent point.
let anchor: { x: number; y: number } | null = null;
let latest: { x: number; y: number; mat: number; radius: number } | null = null;
let dirty = false;
let lastSend = 0;

function setNet(n: NetState) {
  net = n;
  postStatus();
}

function postStatus() {
  send({
    type: "net",
    state: net,
    players,
    playerId: myId,
    reason: rejected,
    progress: ls ? ls.progress : 0,
    latencyMs,
    pingMs,
    resyncs,
  });
}

function sendPaint(mat: number, x0: number, y0: number, x1: number, y1: number, radius: number) {
  if (localSim) {
    localSim.pushInput(encodePaint(0, mat, x0, y0, x1, y1, radius));
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN || net !== "live") return;
  const payload = encodePaint(0, mat, x0, y0, x1, y1, radius).subarray(5);
  if (payload.length !== PAINT_PAYLOAD_LEN) return;
  ws.send(encodeInput(++inputSeq, KIND_PAINT, payload) as BufferSource);
  sentAt.push(performance.now());
}

function flushStroke(force: boolean) {
  if (!dirty || !anchor || !latest) return;
  const now = performance.now();
  if (!force && now - lastSend < SEND_EVERY_MS) return;
  sendPaint(latest.mat, anchor.x, anchor.y, latest.x, latest.y, latest.radius);
  anchor = { x: latest.x, y: latest.y };
  dirty = false;
  lastSend = now;
}

function worldSize(): { w: number; h: number } {
  const s = localSim ?? ls?.sim;
  return s ? { w: s.width(), h: s.height() } : { w: 512, h: 512 };
}

function onPointer(m: Extract<ToWorker, { type: "pointer" }>) {
  const { w, h } = worldSize();
  const x = Math.max(0, Math.min(w - 1, Math.round(m.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(m.y)));
  if (m.kind === "up") {
    flushStroke(true);
    anchor = latest = null;
    return;
  }
  if (m.kind === "down" || !anchor) {
    anchor = { x, y };
    latest = { x, y, mat: m.mat, radius: m.radius };
    dirty = true;
    flushStroke(true);
    return;
  }
  latest = { x, y, mat: m.mat, radius: m.radius };
  dirty = true;
  flushStroke(false);
}

function onTickApplied(tick: number, inputs: { player: number; kind: number }[]) {
  if (ls && ws && ws.readyState === WebSocket.OPEN) {
    const r = reactToTick(ls, tick, wantSnapshotAt);
    if (r.hash !== undefined) ws.send(encodeHash(tick, r.hash) as BufferSource);
    if (r.snapshot) {
      wantSnapshotAt = 0;
      ws.send(encodeSnapshotUpload(tick, r.snapshot.hash, r.snapshot.data) as BufferSource);
    }
  }
  for (const i of inputs) {
    if (i.player === myId && i.kind === KIND_PAINT) {
      const t = sentAt.shift();
      if (t !== undefined) latencyMs = performance.now() - t;
    }
  }
}

// Presence is counted from the tick stream as it arrives (UI only; never feeds the sim).
function countPresence(inputs: { kind: number }[]) {
  for (const i of inputs) {
    if (i.kind === KIND_JOIN) players++;
    else if (i.kind === KIND_LEAVE) players--;
  }
}

/** A fresh sim per connection or resync; it is restored from the snapshot (if any) and fast-forwarded. */
function beginReplay(seed: bigint, worldKind: number, target: number, playersAtBase: number) {
  const sim: Sim = loadSim(wasmBytes);
  sim.init(seed, worldKind);
  ls = new Lockstep(sim);
  ls.catchUpTarget = target;
  ls.onStepped = onTickApplied;
  players = playersAtBase;
  wantSnapshotAt = 0;
  setNet(target > 0 ? "catching-up" : "live");
  send({ type: "world", width: sim.width(), height: sim.height(), kind: worldKind });
  renderer?.setWorld(sim.width(), sim.height());
}

function connect() {
  ls = null;
  myId = 0;
  players = 0;
  sentAt = [];
  anchor = latest = null;
  setNet(attempt === 0 ? "connecting" : "reconnecting");
  const sock = new WebSocket(wsUrl);
  sock.binaryType = "arraybuffer";
  ws = sock;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  sock.onopen = () => sock.send(encodeHello(buildHash, 0) as BufferSource);
  sock.onmessage = (e) => {
    if (sock !== ws) return;
    const m = decodeServer(new Uint8Array(e.data as ArrayBuffer));
    if (!m) return sock.close();
    switch (m.t) {
      case "welcome": {
        seedInfo = { seed: m.seed, kind: m.worldKind };
        beginReplay(m.seed, m.worldKind, m.tick, m.playersAtBase);
        myId = m.playerId;
        attempt = 0;
        pingTimer = setInterval(() => sock.send(encodePing(Math.round(performance.now()) >>> 0) as BufferSource), 2000);
        break;
      }
      case "snapshot":
        if (!ls) return sock.close();
        try {
          ls.loadSnapshot(m.data, m.tick);
        } catch (err) {
          console.error("[worker]", err);
          return sock.close();
        }
        break;
      case "resync":
        if (!seedInfo) return sock.close();
        resyncs++;
        beginReplay(seedInfo.seed, seedInfo.kind, m.tick, m.playersAtBase);
        break;
      case "request-snapshot":
        wantSnapshotAt = m.tick;
        break;
      case "tick":
        if (!ls) return sock.close();
        try {
          ls.push(m.tick, m.inputs);
        } catch (err) {
          console.error("[worker]", err);
          return sock.close();
        }
        countPresence(m.inputs);
        break;
      case "pong":
        pingMs = (performance.now() >>> 0) - m.ts;
        break;
      case "reject":
        rejected = m.reason;
        setNet("rejected");
        break;
    }
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (sock !== ws) return;
    ls = null;
    if (net === "rejected") return; // do not hammer a server that said reload
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt++;
    setNet("reconnecting");
    setTimeout(connect, delay);
  };
  sock.onerror = () => {};
}

let acc = 0;
let last = 0;
let statSteps = 0;
let statStart = 0;

function frame(now: number) {
  const dt = Math.min(now - last, 250);
  last = now;
  flushStroke(false);
  if (localSim) {
    acc += dt;
    const n = Math.min(Math.floor(acc / STEP_MS), MAX_FRAME_STEPS);
    acc -= Math.floor(acc / STEP_MS) * STEP_MS;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      localSim.step();
      stepTimes.push(performance.now() - t0);
      if (stepTimes.length > 600) stepTimes.shift();
      statSteps++;
    }
    ranChunks = localSim.ranChunks();
    if (renderer) {
      renderer.draw(localSim.matView(), localSim.auxView(), now / 1000, cam);
    } else if (sendFrames) {
      const m = localSim.matView().slice();
      const a = localSim.auxView().slice();
      send({ type: "frame", mat: m, aux: a, tick: localSim.tick() }, [m.buffer, a.buffer]);
    }
  } else if (ls) {
    if (net === "catching-up") {
      ls.fastForward(FF_BUDGET_MS);
      statSteps = 0;
      if (!ls.fastForwarding) {
        acc = 0;
        setNet("live");
      }
    } else {
      acc += dt;
      const base = Math.min(Math.floor(acc / STEP_MS), MAX_FRAME_STEPS);
      acc -= Math.floor(acc / STEP_MS) * STEP_MS;
      statSteps += ls.run(ls.plan(base));
    }
    if (ls) {
      if (renderer) {
        renderer.draw(ls.sim.matView(), ls.sim.auxView(), now / 1000, cam);
      } else if (sendFrames) {
        const m = ls.sim.matView().slice();
        const a = ls.sim.auxView().slice();
        send({ type: "frame", mat: m, aux: a, tick: ls.simTick }, [m.buffer, a.buffer]);
      }
    }
  }
  if (now - statStart > 500) {
    const sorted = [...stepTimes].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    send({
      type: "stats",
      tick: localSim ? localSim.tick() : ls ? ls.simTick : 0,
      stepsPerSec: (statSteps * 1000) / (now - statStart),
      buffered: ls ? ls.buffered : 0,
      stepP50: q(0.5),
      stepP95: q(0.95),
      ranChunks,
      uploadCells: renderer?.lastUploadCells ?? 0,
    });
    postStatus();
    statSteps = 0;
    statStart = now;
  }
}

function loop() {
  const tickFn = (t: number) => {
    frame(t);
    schedule();
  };
  const schedule = () => {
    if (renderer && typeof ctx.requestAnimationFrame === "function") ctx.requestAnimationFrame(tickFn);
    else setTimeout(() => tickFn(performance.now()), 16);
  };
  last = statStart = performance.now();
  schedule();
}

async function init(m: Extract<ToWorker, { type: "init" }>) {
  wasmBytes = new Uint8Array(await (await fetch(m.wasmUrl)).arrayBuffer());
  buildHash = new Uint8Array(32);
  const hex = await simBuildHash(wasmBytes);
  for (let i = 0; i < 32; i++) buildHash[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  wsUrl = m.wsUrl;
  if (m.canvas) {
    try {
      m.canvas.width = m.width;
      m.canvas.height = m.height;
      renderer = new Renderer(m.canvas);
      console.log("[worker] render path: WebGL2 on OffscreenCanvas in worker");
      send({ type: "ready", path: "worker-webgl2" });
    } catch (e) {
      send({ type: "render-failed", error: String(e) });
    }
  } else {
    sendFrames = true;
    send({ type: "ready", path: "main-thread-fallback" });
  }
  if (m.local) {
    const sim = loadSim(wasmBytes);
    sim.init(BigInt(m.local.seed), m.local.kind);
    localSim = sim;
    setNet("live");
    send({ type: "world", width: sim.width(), height: sim.height(), kind: m.local.kind });
    renderer?.setWorld(sim.width(), sim.height());
  } else {
    connect();
  }
  loop();
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      init(m).catch((err) => send({ type: "error", error: String(err?.stack ?? err) }));
      break;
    case "resize":
      renderer?.resize(m.width, m.height);
      break;
    case "frames":
      renderer = null;
      sendFrames = true;
      break;
    case "pointer":
      onPointer(m);
      break;
    case "camera":
      cam = { x: m.x, y: m.y, vw: m.vw, vh: m.vh };
      break;
    case "sleep":
      localSim?.setSleepEnabled(m.on);
      break;
  }
};
