// The menu's backdrop (HM): the real simulation and the game's own renderer, muted and read-only, on a full-bleed
// canvas behind the menu. It runs a private copy of the sim on the main thread (no network, no worker, no sound)
// and only ever touches that copy. Two sources: the busiest public room's latest stored snapshot (stepped locally
// for motion; it is not that room's live state and never feeds anything back), or, with no occupied public
// room, a short scripted scene of emitters ("the director") pushed in as ordinary Paint inputs.
import { encodePaint } from "../shared/inputs.ts";
import { decompressSnapshot, maxSnapshotRawFor } from "../shared/protocol.ts";
import { CLASSIC_SANDBOX, decodeConfig, encodeConfig } from "../shared/room.ts";
import { loadSim, type Sim } from "../shared/sim.ts";
import { Renderer } from "./render.ts";

const ROCK = 2, SAND = 4, WATER = 5, WOOD = 6, FIRE = 10, LAVA = 14, OIL = 15;
const SCENE_TICKS = 60 * 45; // the scene restarts so it never fills up

interface Emitter { mat: number; x: number; y: number; from: number; to: number; every: number; r: number }

/** Static build (strokes) then timed emitters, in a 512 wide world; x is centred on the world, y counted up from the floor. */
function scene(ox: number): { build: [number, number, number, number, number, number][]; emitters: Emitter[] } {
  const X = (x: number) => ox + x;
  const Y = (y: number) => 470 - y;
  const build: [number, number, number, number, number, number][] = [
    [ROCK, X(-230), Y(0), X(230), Y(0), 5], // floor
    [ROCK, X(-230), Y(0), X(-230), Y(150), 4],
    [ROCK, X(230), Y(0), X(230), Y(150), 4],
    [ROCK, X(-120), Y(60), X(-40), Y(52), 3], // sand ledge
    [ROCK, X(40), Y(0), X(40), Y(34), 3], // pool wall
    [ROCK, X(140), Y(80), X(200), Y(88), 3], // water chute
    [ROCK, X(-200), Y(28), X(-170), Y(28), 2], // wood shelf
    [WOOD, X(-205), Y(40), X(-165), Y(40), 5],
    [WOOD, X(-190), Y(56), X(-175), Y(56), 4],
  ];
  const emitters: Emitter[] = [
    { mat: SAND, x: X(-80), y: Y(170), from: 0, to: 60 * 28, every: 2, r: 2 },
    { mat: WATER, x: X(170), y: Y(200), from: 30, to: 60 * 30, every: 2, r: 2 },
    { mat: LAVA, x: X(20), y: Y(160), from: 60 * 14, to: 60 * 24, every: 4, r: 2 },
    { mat: OIL, x: X(-60), y: Y(150), from: 60 * 30, to: 60 * 34, every: 4, r: 2 },
    { mat: FIRE, x: X(-185), y: Y(46), from: 60 * 4, to: 60 * 5, every: 5, r: 3 },
    { mat: FIRE, x: X(-70), y: Y(30), from: 60 * 36, to: 60 * 38, every: 5, r: 3 },
  ];
  return { build, emitters };
}

export interface MenuPreview {
  /** Swap to the live room view for this room code, or back to the scripted scene when null. */
  setRoom(code: string | null): void;
  destroy(): void;
}

export async function startMenuPreview(canvas: HTMLCanvasElement, touch: boolean, reduced: boolean): Promise<MenuPreview> {
  const wasm = new Uint8Array(await (await fetch(new URL("sim.wasm", document.baseURI).href)).arrayBuffer());
  const sim: Sim = loadSim(wasm);
  const renderer = new Renderer(canvas);
  let camX = 0, camY = 0, vw = 1, vh = 1;
  let ww = 0, wh = 0;
  let mode: "scene" | "room" = "scene";
  let room: string | null = null;
  let tick0 = 0;
  let dead = false;
  let paintSeq: ReturnType<typeof scene> = scene(256);

  const layout = () => {
    const k = touch ? 3 : innerWidth > 1800 ? 4 : 3; // whole-number scale, like the game
    const dpr = devicePixelRatio || 1;
    vw = Math.min(ww || 512, Math.ceil(innerWidth / k));
    vh = Math.min(wh || 512, Math.ceil(innerHeight / k));
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    // The window sits at the bottom of the scene (the floor) and in the middle of a room's world.
    camX = Math.max(0, Math.floor(((ww || 512) - vw) / 2));
    camY = mode === "scene" ? Math.max(0, 482 - vh) : Math.max(0, Math.floor(((wh || 512) - vh) / 2));
    paintSeq = scene(Math.floor(((ww || 512) - 0) / 2));
  };

  const startScene = () => {
    mode = "scene";
    sim.init(BigInt(Date.now() & 0xffff), encodeConfig(CLASSIC_SANDBOX));
    ww = sim.width();
    wh = sim.height();
    renderer.setWorld(ww, wh);
    layout();
    for (const [m, x0, y0, x1, y1, r] of paintSeq.build) sim.pushInput(encodePaint(0, m, x0, y0, x1, y1, r));
    tick0 = 0;
  };

  let snapshotAt = 0;
  async function loadRoom(code: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/rooms/${code}/preview`);
      if (!res.ok) return false;
      const cfgBytes = Uint8Array.from(atob(res.headers.get("x-room-config") ?? ""), (c) => c.charCodeAt(0));
      const cfg = decodeConfig(cfgBytes);
      if (!cfg) return false;
      const data = new Uint8Array(await res.arrayBuffer());
      sim.init(0n, cfgBytes);
      sim.restore(decompressSnapshot(data, maxSnapshotRawFor(cfg)));
      mode = "room";
      ww = sim.width();
      wh = sim.height();
      renderer.setWorld(ww, wh);
      layout();
      snapshotAt = performance.now();
      return true;
    } catch {
      return false;
    }
  }

  let stepAcc = 0;
  let last = performance.now();
  let hidden = document.hidden;
  let raf = 0;
  const rate = touch ? 30 : 60; // steps a second
  const frame = (now: number) => {
    raf = 0;
    if (dead || hidden) return;
    const dt = Math.min(100, now - last);
    last = now;
    stepAcc += (dt * rate) / 1000;
    let n = Math.min(Math.floor(stepAcc), 4);
    stepAcc -= Math.floor(stepAcc);
    while (n-- > 0) {
      if (mode === "scene") {
        for (const e of paintSeq.emitters) {
          if (tick0 >= e.from && tick0 < e.to && tick0 % e.every === 0) sim.pushInput(encodePaint(0, e.mat, e.x, e.y, e.x, e.y, e.r));
        }
        if (++tick0 >= SCENE_TICKS) startScene();
      }
      sim.step();
    }
    // A room view older than a minute is re-fetched (the room's snapshot moves on every 30 s of its life).
    if (mode === "room" && room && now - snapshotAt > 45000) void loadRoom(room);
    renderer.draw(sim.matView(), sim.auxView(), now / 1000, { x: camX, y: camY, vw, vh });
    raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (!raf && !dead && !hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  startScene();
  if (reduced) {
    // One still frame after a few seconds of warm-up steps, no animation loop.
    for (let i = 0; i < 60 * 20; i++) {
      for (const e of paintSeq.emitters) if (tick0 >= e.from && tick0 < e.to && tick0 % e.every === 0) sim.pushInput(encodePaint(0, e.mat, e.x, e.y, e.x, e.y, e.r));
      tick0++;
      sim.step();
    }
    renderer.draw(sim.matView(), sim.auxView(), 0, { x: camX, y: camY, vw, vh });
  } else kick();
  const onVis = () => {
    hidden = document.hidden;
    kick();
  };
  const onResize = () => {
    layout();
    if (reduced) renderer.draw(sim.matView(), sim.auxView(), 0, { x: camX, y: camY, vw, vh });
  };
  document.addEventListener("visibilitychange", onVis);
  addEventListener("resize", onResize);
  return {
    setRoom(code) {
      if (reduced || code === room) return;
      room = code;
      if (code === null) startScene();
      else void loadRoom(code).then((ok) => { if (!ok && room === code) { room = null; if (mode === "room") startScene(); } });
    },
    destroy() {
      dead = true;
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("resize", onResize);
    },
  };
}
