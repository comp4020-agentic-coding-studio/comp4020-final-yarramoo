// Messages between main thread and worker.
import type { Rect } from "./render.ts";
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
      local?: { kind: number; seed: string; /** ?avatar=1: join as player 1 so damage, death and bags can be seen alone. */ avatar?: boolean };
      /** Which server world to join: 0 sandbox, 1 game. */
      worldId: number;
      /** The player token, 64 hex characters, or "" (spectators and the sandbox send none). */
      token: string;
      /** This player's own display name, for the label above their avatar. */
      name: string;
      /** Watch only: no avatar, no Join (phones in the game world, D-011). */
      spectate: boolean;
    }
  /** Held movement keys, for the avatar controller. */
  | { type: "keys"; left: boolean; right: boolean; up: boolean }
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
  | { type: "camera"; x: number; y: number; vw: number; vh: number }
  | { type: "resize"; width: number; height: number }
  /** Switch to sending frames to the main thread (render fallback). */
  | { type: "frames" }
  | { type: "pointer"; kind: "down" | "move" | "up"; x: number; y: number; mat: number; radius: number };

export type FromWorker =
  | { type: "ready"; path: "worker-webgl2" | "main-thread-fallback" }
  | { type: "render-failed"; error: string }
  | { type: "world"; width: number; height: number; kind: number }
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
      list: { id: number; name: string; x: number; y: number; me: boolean; health: number; dead: boolean }[];
      /** My own health and death countdown (null respawnTicks: unknown, e.g. I joined while dead). Render-only. */
      me: { health: number; dead: boolean; respawnTicks: number | null } | null;
      /** Dropped bags as the entities() view gives them: cell centre in cells and total charges. Render-only. */
      bags: { x: number; y: number; total: number }[];
      cam: { x: number; y: number };
      /** The worker is steering the camera (avatar or followed player); otherwise the main thread pans freely. */
      following: boolean;
      energy: number;
      energyMax: number;
      /** My spells for the HUD (charges 65535 = infinite, cooldown in ticks left), or null. Render-only. */
      spells: { charges: number[]; cooldown: number[] } | null;
    }
  /** A line for the death feed, already formatted from a plain-name death event. */
  | { type: "toast"; text: string }
  /** The server says this player earned an achievement (by id; the main thread looks the text up). */
  | { type: "achievement"; id: string }
  | { type: "error"; error: string };
