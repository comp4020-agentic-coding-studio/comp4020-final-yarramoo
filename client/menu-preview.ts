// Menu backdrop (playtest note 2, slice H2, variant "local"): a real sim runs in the game's own worker behind
// the menu, fed Paint inputs by a small scripted director. It is a private local sandbox (the worker's
// `local` mode): no socket, no room, no sound. Input reaches the sim only as pointer messages that the worker
// turns into Paint inputs (invariant 1); the canvas itself ignores the pointer.
import type { FromWorker, ToWorker } from "./protocol.ts";

const ROCK = 2, SAND = 4, WATER = 5, WOOD = 6, FIRE = 10, LAVA = 14, ERASE = 0;
const WORLD = 512;
const DIRECTOR_MS = 50;
/** Restart the scene (a fresh worker) after this many visible seconds, so it never fills up or stalls. */
const LOOP_S = 80;

type Paint = [mat: number, x: number, y: number, r: number];

/** Everything is placed relative to the visible window (`w` x `h` cells) so it composes at any aspect. */
function sceneAt(w: number, h: number, phone: boolean) {
  const X = (f: number) => Math.round(f * w);
  const floor = h - 6;
  const strokes: [number, number, number, number, number, number][] = []; // mat, x0, y0, x1, y1, r
  const wall = (x0: number, y0: number, x1: number, y1: number) => strokes.push([ROCK, x0, y0, x1, y1, 2]);
  wall(0, floor, w - 1, floor); // the ground, thick enough to hold lava
  // Sand ledge, a gentle slope from the top middle toward the left pool.
  wall(X(0.34), Math.round(h * 0.42), X(0.52), Math.round(h * 0.5));
  // Water basin (left).
  wall(X(0.06), floor - 24, X(0.06), floor);
  wall(X(0.22), floor - 24, X(0.22), floor);
  // Lava pocket (right), its left wall low so the stream from the ledge can splash over.
  wall(X(0.66), floor - 26, X(0.66), floor);
  wall(X(0.86), floor - 26, X(0.86), floor);
  // A wooden shelf with kindling, far right.
  strokes.push([WOOD, X(0.9), Math.round(h * 0.55), X(0.99), Math.round(h * 0.55), 2]);
  strokes.push([WOOD, X(0.92), Math.round(h * 0.55) - 8, X(0.97), Math.round(h * 0.55) - 8, 2]);
  const emitters: { every: number; start: number; paint: Paint }[] = [
    { every: 2, start: 0, paint: [SAND, X(0.42), 4, 3] }, // sand pour onto the ledge
    { every: 3, start: 20, paint: [WATER, X(0.14), 4, 3] }, // water fall into the basin
    { every: 4, start: 20, paint: [WATER, X(0.7), 4, 2] }, // water stream onto the lava
    { every: 90, start: 8, paint: [LAVA, X(0.76), floor - 20, 9] }, // top the lava pocket up
    { every: 70, start: 40, paint: [FIRE, X(0.95), Math.round(h * 0.55) - 12, 3] }, // fire on the wood
  ];
  if (phone) emitters.splice(2, 1);
  // Drains keep the corners from filling: erase a patch at each end of the ground.
  const drains: Paint[] = [
    [ERASE, 1, floor - 1, 5],
    [ERASE, w - 2, floor - 1, 5],
  ];
  return { strokes, emitters, drains };
}

export function startMenuPreview(host: HTMLElement): { stop(): void } {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = matchMedia("(pointer: coarse)").matches && innerWidth < 900;
  let worker: Worker | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let timer = 0;
  let loopTimer = 0;
  let stopped = false;
  let hidden = document.hidden;
  let paceFn: (() => void) | null = null;

  function begin() {
    if (stopped) return;
    // Whole-number scale: the biggest cell size that still leaves the view inside the 512-cell world.
    const W = innerWidth, H = innerHeight;
    let k = Math.max(1, Math.ceil(Math.max(W, H) / WORLD));
    if (phone) k = Math.max(k, 2);
    const vw = Math.min(WORLD, Math.ceil(W / k));
    const vh = Math.min(WORLD, Math.ceil(H / k));
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.className = "preview-canvas";
    c.width = Math.round(vw * k * dpr);
    c.height = Math.round(vh * k * dpr);
    c.style.width = vw * k + "px";
    c.style.height = vh * k + "px";
    host.replaceChildren(c);
    canvas = c;
    let n = 0, built = 0, ready = false;
    const wk = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker = wk;
    const send = (m: ToWorker, t?: Transferable[]) => wk.postMessage(m, t ?? []);
    wk.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type === "world") ready = true;
      if (e.data.type === "stats" && canvas === c) c.classList.add("on");
      if (e.data.type === "render-failed" || e.data.type === "error") stop();
    };
    const off = c.transferControlToOffscreen();
    send(
      { type: "init", wasmUrl: new URL("sim.wasm", document.baseURI).href, wsUrl: "", width: c.width, height: c.height, local: { kind: 0, seed: "7" }, worldId: 0, token: "", name: "", spectate: true, reduced, canvas: off },
      [off],
    );
    const camY = WORLD - vh, camX = Math.floor((WORLD - vw) / 2);
    send({ type: "camera", x: camX, y: camY, vw, vh });
    const sc = sceneAt(vw, vh, phone);
    const at = (p: Paint) => {
      send({ type: "pointer", kind: "down", x: camX + p[1], y: camY + p[2], mat: p[0], radius: p[3], fillEmpty: false });
      send({ type: "pointer", kind: "up", x: 0, y: 0, mat: 0, radius: 0, fillEmpty: false });
    };
    const pace = () => send({ type: "pace", paused: hidden || (reduced && n > 160), stepMs: phone ? 1000 / 30 : 1000 / 60 });
    const tickDirector = () => {
      if (!ready || hidden || (reduced && n > 160)) return;
      // The terrain goes in over the first few ticks, one stroke each (the sim clamps a stroke to 128 cells).
      if (built < sc.strokes.length) {
        const s = sc.strokes[built++];
        const len = Math.max(Math.abs(s[3] - s[1]), Math.abs(s[4] - s[2]));
        for (let a = 0; a < len; a += 120) {
          const t0 = a / len, t1 = Math.min(len, a + 120) / len;
          const px = (t: number) => camX + Math.round(s[1] + (s[3] - s[1]) * t);
          const py = (t: number) => camY + Math.round(s[2] + (s[4] - s[2]) * t);
          send({ type: "pointer", kind: "down", x: px(t0), y: py(t0), mat: s[0], radius: s[5], fillEmpty: false });
          send({ type: "pointer", kind: "move", x: px(t1), y: py(t1), mat: s[0], radius: s[5], fillEmpty: false });
          send({ type: "pointer", kind: "up", x: 0, y: 0, mat: 0, radius: 0, fillEmpty: false });
        }
        return;
      }
      n++;
      for (const e of sc.emitters) if (n >= e.start && n % e.every === 0) at(e.paint);
      if (n % 40 === 0) for (const d of sc.drains) at(d);
    };
    pace();
    timer = window.setInterval(tickDirector, DIRECTOR_MS);
    // Reduced motion shows a still frame once the scene has had time to form; otherwise loop.
    if (!reduced) loopTimer = window.setTimeout(restart, LOOP_S * 1000);
    else window.setTimeout(pace, 12_000);
    paceFn = pace;
  }

  function teardown() {
    clearInterval(timer);
    clearTimeout(loopTimer);
    worker?.terminate();
    worker = null;
  }
  function restart() {
    const old = canvas;
    old?.classList.remove("on");
    window.setTimeout(() => {
      teardown();
      begin();
    }, 700);
  }
  function stop() {
    stopped = true;
    teardown();
    host.replaceChildren();
  }
  function onVis() {
    hidden = document.hidden;
    paceFn?.();
  }
  document.addEventListener("visibilitychange", onVis);
  begin();
  return {
    stop() {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    },
  };
}
