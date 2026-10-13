// Owns the sim, the WebSocket and the playout buffer; steps only through closed ticks from the server,
// and (when it can) renders with WebGL2 into an OffscreenCanvas.
import { KIND_JOIN, KIND_LEAVE, KIND_PAINT, encodePaint } from "../shared/inputs.ts";
import { PAINT_PAYLOAD_LEN, decodeServer, encodeHello, encodeInput, encodePing } from "../shared/protocol.ts";
import { loadSim, simBuildHash, type Sim } from "../shared/sim.ts";
import { Lockstep } from "./lockstep.ts";
import { WORLD } from "./materials.ts";
import type { FromWorker, NetState, ToWorker } from "./protocol.ts";
import { Renderer } from "./render.ts";

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

// Per-connection state; discarded on reconnect (the replay rebuilds it).
let ws: WebSocket | null = null;
let ls: Lockstep | null = null;
let myId = 0;
let players = 0;
let net: NetState = "connecting";
let attempt = 0;
let inputSeq = 0;
let sentAt: number[] = []; // send times of my paints not yet seen applied
let latencyMs = 0;
let pingMs = 0;
let rejected = "";

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
  });
}

function sendPaint(mat: number, x0: number, y0: number, x1: number, y1: number, radius: number) {
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

function onPointer(m: Extract<ToWorker, { type: "pointer" }>) {
  const x = Math.max(0, Math.min(WORLD - 1, Math.round(m.x)));
  const y = Math.max(0, Math.min(WORLD - 1, Math.round(m.y)));
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

function onTickApplied(_tick: number, inputs: { player: number; kind: number }[]) {
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
        // A fresh sim instance per connection: discard everything and replay the log.
        const sim: Sim = loadSim(wasmBytes);
        sim.init(m.seed, m.worldKind);
        ls = new Lockstep(sim);
        ls.catchUpTarget = m.tick;
        ls.onStepped = onTickApplied;
        myId = m.playerId;
        attempt = 0;
        setNet(m.tick > 0 ? "catching-up" : "live");
        pingTimer = setInterval(() => sock.send(encodePing(Math.round(performance.now()) >>> 0) as BufferSource), 2000);
        break;
      }
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
  if (ls) {
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
        renderer.draw(ls.sim.matView(), ls.sim.auxView(), now / 1000);
      } else if (sendFrames) {
        const m = ls.sim.matView().slice();
        const a = ls.sim.auxView().slice();
        send({ type: "frame", mat: m, aux: a, tick: ls.simTick }, [m.buffer, a.buffer]);
      }
    }
  }
  if (now - statStart > 500) {
    send({ type: "stats", tick: ls ? ls.simTick : 0, stepsPerSec: (statSteps * 1000) / (now - statStart), buffered: ls ? ls.buffered : 0 });
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
  connect();
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
  }
};
