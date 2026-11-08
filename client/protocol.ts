// Messages between main thread and worker.
import type { RoomConfig } from "../shared/room.ts";
import type { Rect } from "./render.ts";
import type { SfxName } from "./sfx.ts";
export type NetState = "connecting" | "catching-up" | "live" | "reconnecting" | "rejected";

export type ToWorker =
  | {
      type: "init";
      wasmUrl: string;
      wsUrl: string;
      canvas?: OffscreenCanvas;
      width: number;
      height: number;
      /** Dev: run a local single-player sim of this world kind instead of connecting (no networking). */
      local?: { kind: number; seed: string; /** ?avatar=1: join as player 1 so damage, death and bags can be seen alone. */ avatar?: boolean; /** Dev: `survival` starts the local sim from the SURVIVAL preset (enemies on). `menu`: the menu backdrop's MENU_BACKDROP config (client/menu/backdrop-config.ts), no "me" markers. */ cfg?: string };
      /** Which server world/room to join: 0 sandbox, 1 game, or any real room id from GET /api/rooms/:code (R3). */
      worldId: number;
      /** Dev only: force a sky kind (`?sky=rain`). Otherwise the sky comes from the room seed. */
      sky?: string;
      /** prefers-reduced-motion: the sky holds still. */
      reduced?: boolean;
      /** The player token, 64 hex characters, or "" (spectators and the sandbox send none). */
      token: string;
      /** This player's own display name, for the label above their avatar. */
      name: string;
      /** Watch only: no avatar, no Join (phones in the game world, D-011). */
      spectate: boolean;
    }
  /** Held movement keys, for the avatar controller. */
  /** Menu backdrop only: pause stepping and drawing, or slow the step rate. `drawMs`: minimum ms between draws
   * (0 every frame, -1 never: the sim steps but nothing is drawn). Never an input. */
  | { type: "pace"; paused: boolean; stepMs: number; drawMs?: number }
  /** Menu backdrop only: teleport the LOCAL controller (cells, feet). Ignored unless a local sim runs; the move reaches the sim as the controller's ordinary Pos. */
  | { type: "goto"; x: number; y: number }
  | { type: "keys"; left: boolean; right: boolean; up: boolean }
  /** The tab was hidden or shown: while hidden the avatar sends no Pos and no casts (brief F item 1b). */
  | { type: "hidden"; hidden: boolean }
  /**
   * Cast a spell: the angle is ALREADY quantised to u16 (65536 per turn) by the main thread (invariant 2).
   * The worker owns the cast_seq, the preview ghost and the input.
   */
  | { type: "cast"; spell: number; angle: number }
  /** Follow the avatar (or, for a spectator, the first other player) with the camera. */
  | { type: "follow"; on: boolean; /** Spectator: follow this player rather than the first other one. Camera only. */ id?: number }
  /** Client-only camera: the world window to draw, in cells. Never an input. */
  /** Dev (local mode only): switch chunk sleeping, to measure what it buys. */
  | { type: "sleep"; on: boolean }
  /** Debug view: outline the sim's active chunk box (`__activeBox(on)` or `?activebox=1`). Drawing only, never an input. */
  | { type: "activebox"; on: boolean }
  /** Dev route only: set the boss's hp (`__devBossHp`). */
  | { type: "devbosshp"; hp: number }
  | { type: "camera"; x: number; y: number; vw: number; vh: number }
  | { type: "resize"; width: number; height: number }
  /** Switch to sending frames to the main thread (render fallback). */
  | { type: "frames" }
  | { type: "devgoto"; spell: number; /** The server announced dev teleport for this room: act in a real room, not only on the dev route. */ remote?: boolean; /** Stand this many cells from the enemy instead of the default (12; the boss 14 to its right). For the boss it is signed: the offset from its x. */ dist?: number }
  /** F6b: toggle my lobby ready flag (the worker sends the Ready input; the sim ignores it outside a Survival lobby). */
  | { type: "ready"; ready: boolean }
  /** The mouse has rested at this world point (cells): look up what is under it. Display only, never an input, never sent on. */
  | { type: "hover"; x: number; y: number }
  | { type: "chat"; text: string }
  | { type: "pointer"; kind: "down" | "move" | "up"; x: number; y: number; mat: number; radius: number; fillEmpty: boolean };

export type FromWorker =
  | { type: "ready"; path: "worker-webgl2" | "main-thread-fallback" }
  | { type: "render-failed"; error: string }
  /** `kind` is just "has avatars" (0/1), for the existing render checks. `cfg` is the real decoded room config (R3), null only for a config the server rejects (never for a real WELCOME). */
  | { type: "world"; width: number; height: number; kind: number; cfg: RoomConfig | null; /** Cave terrain (sky above ground only, depth bands). */ caves?: boolean; /** Sky kind index and whether it moves, for the main-thread fallback renderer. */ sky?: number; skyMotion?: boolean }
  | { type: "frame"; mat: Uint8Array; aux: Uint8Array; tick: number; rects: Rect[] }
  | { type: "stats"; tick: number; stepsPerSec: number; buffered: number; stepP50: number; stepP95: number; ranChunks: number; uploadCells: number }
  | {
      type: "net";
      state: NetState;
      players: number;
      playerId: number;
      reason: string;
      /** 0..1 replay progress while catching up. */
      progress: number;
      /** Sim tick and replay target while catching up (display only). */
      tick: number;
      target: number;
      /** Last own-paint latency: send to applied in the sim, ms. */
      latencyMs: number;
      pingMs: number;
      /** Times the server told this client to resync after a hash disagreement. */
      resyncs: number;
    }
  /** Game world, about 30 Hz: who to draw labels for, where the camera is, and avatar state. */
  | {
      type: "players";
      list: { id: number; name: string; x: number; y: number; me: boolean; health: number; dead: boolean; /** Player colour as 0..255 RGB, for the minimap dot. */ rgb: [number, number, number] }[];
      /** My own health and death countdown (null respawnTicks: unknown, e.g. I joined while dead). Render-only. */
      me: { health: number; dead: boolean; respawnTicks: number | null; /** "Killed by a Fire imp" and the like, from my latest EV_DEATH; null when unknown. */ deathText: string | null } | null;
      /** The deepest any living player has been seen on this client (cells, display only). */
      deepest: number;
      /** Dropped bags as the entities() view gives them: cell centre in cells and total charges. Render-only. */
      bags: { x: number; y: number; total: number }[];
      cam: { x: number; y: number };
      /** The worker is steering the camera (avatar or followed player); otherwise the main thread pans freely. */
      following: boolean;
      energy: number;
      energyMax: number;
      /** The Deep Mage while it is in the entities view (hp, max hp, phase 1..3), else null. Render-only. */
      boss: { kind: number; hp: number; max: number; phase: number; x: number; y: number } | null;
      /** My spells for the HUD (charges 65535 = infinite, cooldown in ticks left), or null. Render-only. */
      spells: { charges: number[]; cooldown: number[] } | null;
      /** F6b: the Survival lobby (null when the room has no round). `left` is ticks of countdown left, -1 when none runs. Names are plain. Render-only. */
      lobby: { running: boolean; left: number; /** Ticks until the majority timeout starts the round without the unready, -1 when no majority. */ majorityLeft: number; /** This world's boss kind (4 the Deep Mage, 7 the Sand Colossus), null if none. */ boss: number | null; list: { id: number; name: string; ready: boolean; me: boolean }[] } | null;
      /** F6b: I arrived after the descent began (the sim made me a dead spectator): offer the choice. */
      late: boolean;
      /** Damage-relevant events since the last post (Explode: owner, cell x, y, radius; Knock on me: attacker; Death), for scripts. Read-only. */
      evlog: { k: number; p: number; a: number; b: number; c: number }[];
    }
  /** Display-only: the local player was hit, or hurt an enemy or another player. Drives the fight music (room.ts). */
  | { type: "combat" }
  /** About 1 Hz: a coarse solid/empty mask of the world for the minimap silhouette, `cols` x `rows`, row-major, 1 = solid. Render-only. */
  | { type: "terrain"; cols: number; rows: number; mask: Uint8Array }
  /** A sound for the main thread to synthesise (client/sfx.ts). `vol` 0..1 and `pan` -1..1 are already worked out from the camera distance; `mag` 0..1 scales explosions. Never sent during replay. */
  | { type: "sfx"; name: SfxName; vol: number; pan: number; mag: number }
  /** A line for the death feed, already formatted from a plain-name death event. */
  | { type: "toast"; text: string }
  /** Answer to "hover": the label for what is under the resting mouse, or null. Render-only. */
  | { type: "hover"; text: string | null }
  /** A one-life round ended (`EV_ROUND_END`): `win` false is a loss. Shown as a banner; render-only. */
  | { type: "round"; win: boolean }
  /** The server says this player earned an achievement (by id; the main thread looks the text up). */
  | { type: "achievement"; id: string }
  | { type: "chat"; name: string; text: string; history: boolean }
  | { type: "error"; error: string };
