// Owns the sim, steps it at a steady 60 Hz and (when it can) renders with WebGL2 into an OffscreenCanvas.
import { encodeJoin, encodePaint } from "../shared/inputs.ts";
import { loadSim, type Sim } from "../shared/sim.ts";
import { WORLD } from "./materials.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { Renderer } from "./render.ts";

const STEP_MS = 1000 / 60;
const MAX_CATCHUP = 4;
const PLAYER = 1;
const SEED = 1n;

interface WorkerScope {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
}
const ctx = self as unknown as WorkerScope;
const send = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let sim: Sim;
let renderer: Renderer | null = null;
let sendFrames = false;
let lastPointer: { x: number; y: number } | null = null;
const pending: Uint8Array[] = [];

function grids(): { mat: Uint8Array; aux: Uint8Array } {
  return { mat: sim.matView(), aux: sim.auxView() };
}

function paint(mat: number, x0: number, y0: number, x1: number, y1: number, radius: number) {
  pending.push(encodePaint(PLAYER, mat, x0, y0, x1, y1, radius));
}

function onPointer(m: Extract<ToWorker, { type: "pointer" }>) {
  const x = Math.max(0, Math.min(WORLD - 1, Math.round(m.x)));
  const y = Math.max(0, Math.min(WORLD - 1, Math.round(m.y)));
  if (m.kind === "up") {
    lastPointer = null;
    return;
  }
  // A drag becomes a line segment from the previous pointer position.
  const from = m.kind === "move" && lastPointer ? lastPointer : { x, y };
  paint(m.mat, from.x, from.y, x, y, m.radius);
  lastPointer = { x, y };
}

let acc = 0;
let last = 0;
let statSteps = 0;
let statStart = 0;

function frame(now: number) {
  const dt = Math.min(now - last, 250);
  last = now;
  acc += dt;
  let steps = Math.min(Math.floor(acc / STEP_MS), MAX_CATCHUP);
  acc -= steps * STEP_MS;
  // Never run more than MAX_CATCHUP steps in a frame: drop the backlog instead of spiralling.
  if (acc > STEP_MS) acc = STEP_MS;
  if (steps > 0) {
    // Inputs go in before the next step; they are applied in order by the sim.
    for (const p of pending.splice(0)) sim.pushInput(p);
  }
  while (steps-- > 0) {
    sim.step();
    statSteps++;
  }
  const { mat, aux } = grids();
  if (renderer) {
    renderer.draw(mat, aux, now / 1000);
  } else if (sendFrames) {
    const m = mat.slice();
    const a = aux.slice();
    send({ type: "frame", mat: m, aux: a, tick: sim.tick() }, [m.buffer, a.buffer]);
  }
  if (now - statStart > 500) {
    send({ type: "stats", tick: sim.tick(), stepsPerSec: (statSteps * 1000) / (now - statStart) });
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
  const bytes = new Uint8Array(await (await fetch(m.wasmUrl)).arrayBuffer());
  sim = loadSim(bytes);
  sim.init(SEED, 0);
  sim.pushInput(encodeJoin(PLAYER));
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
      if (sim) onPointer(m);
      break;
  }
};
