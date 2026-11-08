// Menu backdrop (menu redesign W3): a living cross-section of a real Caves world behind the menu. The worker's own
// `local` mode runs a private sim (config MENU_BACKDROP, no socket, no room, no sound) with one local explorer, so
// the slimes, imps and wisps on screen are real sim entities drawn by the game's own renderer; nothing is faked.
// This director only (a) points the camera at constant vignettes, (b) sends `goto` and `keys` to the explorer's
// local controller, (c) paints small landscape additions through the pointer messages. Invariants 1 and 9: the sim
// gets state only as inputs (Paint, Join, Pos), and nothing read back from it ever chooses one: every position
// below is a constant from client/menu/backdrop-config.ts (found offline by tools/menu-vignettes.ts).
import type { FromWorker, ToWorker } from "./protocol.ts";
import { MENU_SEED, VIGNETTES, WINDOW_H, WINDOW_W, type Vignette } from "./menu/backdrop-config.ts";
import { backingSize, coversBackdrop } from "./phone.ts";
import { parseRoute } from "./menu/router.ts";

const SAND = 4, WATER = 5, FIRE = 10, GUNPOWDER = 13, LAVA = 14, SNOW = 27, MOSS = 23;
const DIRECTOR_MS = 50;
/** How long one vignette stays, then a fade to the next. */
const VIGNETTE_S = 25;
const FADE_MS = 1300;
/** A fresh worker (fresh world) after a full round of vignettes, so mobs that died in lava come back. */
const ROUNDS_PER_WORLD = 1;

type Paint = [mat: number, x: number, y: number, r: number];
interface Emitter { every: number; start: number; stop?: number; at: (n: number) => Paint }

/** What falls from the sky edge in each vignette, in the visible window (`x0`, `vw` cells wide). Radii stay <= 6. */
function emittersFor(i: number, v: Vignette, x0: number, vw: number, phone: boolean): Emitter[] {
  const X = (f: number) => Math.round(x0 + f * vw);
  const sky = v.skyY;
  const sweep = (n: number, a: number, b: number, period: number) => X(a + (b - a) * ((n % period) / period));
  const thin = phone ? 2 : 1;
  const tree: Emitter[] = v.treeX >= 0 ? [{ every: 70 * thin, start: 30, at: () => [FIRE, v.treeX, v.treeY - 1, 2] }] : [];
  switch (i % 3) {
    case 0: // lava meets a water trickle on the way down: rock and steam
      return [
        { every: 6, start: 0, at: () => [LAVA, X(0.34), sky, 4] },
        { every: 4 * thin, start: 8, at: () => [WATER, X(0.34) + 12, sky, 3] },
        ...tree,
      ];
    case 1: // sand pours into dunes; a gunpowder seam is sparked
      return [
        { every: 2 * thin, start: 0, at: (n) => [SAND, sweep(n, 0.25, 0.4, 40), sky, 3] },
        { every: 2, start: 40, stop: 70, at: () => [GUNPOWDER, X(0.7), sky, 2] },
        { every: 400, start: 76, at: () => [FIRE, X(0.7), sky + 1, 2] },
        ...tree,
      ];
    default: // snow over a mossy, burning tree
      return [
        { every: 2 * thin, start: 0, at: (n) => [SNOW, sweep(n, 0.1, 0.9, 120), sky, 3] },
        { every: 120, start: 10, at: () => [MOSS, X(0.2), sky, 5] },
        ...tree,
      ];
  }
}

/** The explorer's scripted life: walk right, jump, walk left, jump back, stand: net zero, so it stays near its spot. */
const SCRIPT: { ms: number; left: boolean; right: boolean; up: boolean }[] = [
  { ms: 900, left: false, right: true, up: false },
  { ms: 220, left: false, right: true, up: true },
  { ms: 700, left: false, right: false, up: false },
  { ms: 1600, left: true, right: false, up: false },
  { ms: 220, left: true, right: false, up: true },
  { ms: 800, left: false, right: true, up: false },
  { ms: 900, left: false, right: false, up: false },
];
const SCRIPT_MS = SCRIPT.reduce((a, s) => a + s.ms, 0);

export function startMenuPreview(host: HTMLElement): { stop(): void } {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = matchMedia("(pointer: coarse)").matches && innerWidth < 900;
  let worker: Worker | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let timer = 0;
  let stopped = false;
  let hidden = document.hidden;
  const isCovered = () => phone && coversBackdrop(parseRoute(location.hash).kind);
  let covered = isCovered();
  let paceFn: (() => void) | null = null;

  function begin() {
    if (stopped) return;
    // Whole-number scale; at 3 a 5-12 cell mob is 15-36 px. Very large screens go up to 4 so the view stays inside the world.
    const W = innerWidth, H = innerHeight;
    const k = Math.max(3, Math.ceil(Math.max(W, H) / 640));
    const vw = Math.min(WINDOW_W * 2, Math.ceil(W / k));
    const vh = Math.min(WINDOW_H * 2, Math.ceil(H / k));
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.className = "preview-canvas";
    // Phones: one backing pixel per cell (client/phone.ts); CSS `pixelated` scales it to the same picture.
    const px = backingSize(vw, vh, vw * k, vh * k, dpr, phone);
    c.width = px.w;
    c.height = px.h;
    c.style.width = vw * k + "px";
    c.style.height = vh * k + "px";
    host.replaceChildren(c);
    canvas = c;
    let ready = false;
    let vi = 0; // vignette index, counted across the worker's life
    let n = 0; // director ticks since this vignette formed
    let t0 = 0; // when this vignette started
    let emitters: Emitter[] = [];
    let moving = false; // between vignettes (fade): no painting
    const wk = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker = wk;
    const send = (m: ToWorker, t?: Transferable[]) => wk.postMessage(m, t ?? []);
    wk.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type === "world" && !ready) {
        ready = true;
        enter(0);
      }
      if (e.data.type === "stats") {
        if (canvas === c && !moving) c.classList.add("on");
        (window as unknown as { __menuStats?: unknown }).__menuStats = { stepP50: e.data.stepP50, stepP95: e.data.stepP95, stepsPerSec: e.data.stepsPerSec, ranChunks: e.data.ranChunks };
      }
      if (e.data.type === "render-failed" || e.data.type === "error") stop();
    };
    const off = c.transferControlToOffscreen();
    send(
      { type: "init", wasmUrl: new URL("sim.wasm", document.baseURI).href, wsUrl: "", width: c.width, height: c.height, local: { kind: 1, seed: MENU_SEED, avatar: true, cfg: "menu" }, worldId: 0, token: "", name: "", spectate: false, reduced, canvas: off },
      [off],
    );
    send({ type: "follow", on: false });

    /** Camera window for vignette `v`: centred on the vignette's window, or on the explorer when the view is narrower (phone). */
    function enter(i: number) {
      const v = VIGNETTES[i % VIGNETTES.length];
      const cx = vw >= WINDOW_W ? v.camX + Math.round((WINDOW_W - vw) / 2) : Math.round(v.x - vw / 2);
      const cy = v.camY + Math.round((WINDOW_H - vh) / 2);
      const camX = Math.max(0, Math.min(1024 - vw, cx)), camY = Math.max(0, Math.min(768 - vh, cy));
      send({ type: "camera", x: camX, y: camY, vw, vh });
      send({ type: "goto", x: v.x, y: v.y });
      emitters = emittersFor(i, v, camX, vw, phone);
      n = 0;
      t0 = performance.now();
      moving = false;
      c.classList.add("on");
    }
    const at = (p: Paint) => {
      send({ type: "pointer", kind: "down", x: p[1], y: p[2], mat: p[0], radius: p[3], fillEmpty: false });
      send({ type: "pointer", kind: "up", x: 0, y: 0, mat: 0, radius: 0, fillEmpty: false });
    };
    // Lead fix: `>=`, so the pace() sent at n === 160 really pauses (with `>` it sent paused:false and never again).
    const still = () => reduced && n >= 160;
    // Phones draw at most 30 fps (the sim still steps by real time owed), and not at all behind a panel that covers
    // the scene (settings, join, share): it keeps stepping, so the scene has moved on when it shows again.
    const pace = () => send({ type: "pace", paused: hidden || still(), stepMs: phone ? 1000 / 30 : 1000 / 60, drawMs: covered ? -1 : phone ? 1000 / 30 : 0 });
    let lastKeys = "";
    const director = () => {
      if (!ready || hidden || still() || moving) return;
      const now = performance.now();
      n++;
      for (const e of emitters) if (n >= e.start && (e.stop === undefined || n < e.stop) && n % e.every === 0) at(e.at(n));
      // The explorer's life; under reduced motion it stands still.
      if (!reduced) {
        let ph = (now - t0) % SCRIPT_MS;
        let step = SCRIPT[0];
        for (const s of SCRIPT) {
          step = s;
          if (ph < s.ms) break;
          ph -= s.ms;
        }
        const key = `${step.left}${step.right}${step.up}`;
        if (key !== lastKeys) {
          lastKeys = key;
          send({ type: "keys", left: step.left, right: step.right, up: step.up });
        }
        if (now - t0 > VIGNETTE_S * 1000) next();
      }
      if (reduced && n === 160) pace();
    };
    function next() {
      moving = true;
      send({ type: "keys", left: false, right: false, up: false });
      lastKeys = "";
      c.classList.remove("on");
      vi++;
      window.setTimeout(() => {
        if (stopped || worker !== wk) return;
        if (vi >= VIGNETTES.length * ROUNDS_PER_WORLD) restart();
        else enter(vi);
      }, FADE_MS);
    }
    pace();
    timer = window.setInterval(director, DIRECTOR_MS);
    paceFn = pace;
  }

  function teardown() {
    clearInterval(timer);
    worker?.terminate();
    worker = null;
  }
  function restart() {
    teardown();
    begin();
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
  function onHash() {
    covered = isCovered();
    paceFn?.();
  }
  document.addEventListener("visibilitychange", onVis);
  addEventListener("hashchange", onHash);
  begin();
  return {
    stop() {
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("hashchange", onHash);
      stop();
    },
  };
}
