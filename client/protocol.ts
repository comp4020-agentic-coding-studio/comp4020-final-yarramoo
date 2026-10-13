// Messages between main thread and worker.
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
      local?: { kind: number; seed: string };
    }
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
  | { type: "frame"; mat: Uint8Array; aux: Uint8Array; tick: number }
  | { type: "stats"; tick: number; stepsPerSec: number; buffered: number; stepP50: number; stepP95: number; ranChunks: number }
  | {
      type: "net";
      state: NetState;
      players: number;
      playerId: number;
      reason: string;
      /** 0..1 replay progress while catching up. */
      progress: number;
      /** Last own-paint latency: send to applied in the sim, ms. */
      latencyMs: number;
      pingMs: number;
      /** Times the server told this client to resync after a hash disagreement. */
      resyncs: number;
    }
  | { type: "error"; error: string };
