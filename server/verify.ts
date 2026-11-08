// The ONE place the server loads sim.wasm (plan 7.5): restore an uploaded snapshot and hash it, in worker threads
// so the regeneration of a game world cannot stall the tick clock (D-061). It never calls step() or pushInput():
// invariant 11 still holds.
//
// Warm verifies (D-214, D-213's recommendation 1). `restore` reuses the sim's cached pristine world (its `Base`, D-088)
// only when the snapshot has the seed and config of the last world that instance generated, and every room has its own
// seed (D-201). With one shared worker, two rooms verifying in turn regenerated the world on every verify: 6-18 s at M
// and 35-50 s at L on the Fly quota, against a 10 s timeout. So an occupied room gets its own worker, a "lane", which
// generates the room's world from the server's own seed and config when its first member joins; every later verify of
// that room is warm. A lane holds a whole world (measured 8 Nov: about 30 MB at M, 80-90 MB at L; wasm memory never
// shrinks), so lanes are admitted against a byte budget and the cgroup memory gate, and a room that does not fit
// verifies on the one-shot overflow worker: cold, exactly as every verify was before. A lane is terminated, not merely
// dropped, when its room empties or unloads: only terminating a worker gives its memory back promptly (dropped wasm
// instances were measured piling up to 400 MB before V8 collected them).
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { SIZE_DIMS } from "../shared/room.ts";
import type { EventLog } from "./log.ts";

/** A restore takes well under a second warm; a job over this is a hung worker (review M4a S3). */
export const VERIFY_TIMEOUT_MS = 10_000;
/**
 * A lane's first generation may take this long before the lane is given up (35-50 s at L on the Fly quota, 7 Nov). A
 * verify waiting behind it starts its own `VERIFY_TIMEOUT_MS` only once the world is generated, or the first verify of
 * every L room on the quota would time out, kill the lane, and the next lane would do the same, cold for ever.
 */
export const LANE_WARM_TIMEOUT_MS = 120_000;
/** Estimated bytes all warm lanes together may hold (`laneBytes`): three M rooms, or one L room. */
export const VERIFY_WARM_BUDGET_BYTES = 100 * 1024 * 1024;
/** A worker's fixed cost (isolate, compiled module) before any world is generated, measured about 12 MB. */
const LANE_FIXED_BYTES = 12 * 1024 * 1024;
/** Wasm memory per cell after a generation and a restore, measured 26-27 bytes at M and L (two grids, base planes, chunk state). */
const LANE_BYTES_PER_CELL = 27;

/** The room a verify belongs to: its world id, and the seed and config its lane generates from (the server's own, never an upload's). */
export interface VerifyRoom {
  id: number;
  seed: bigint;
  /** The 16 encoded room-config bytes (`encodeConfig`). */
  cfg: Uint8Array;
  /** `RoomConfig.size`, for the memory estimate. */
  size: number;
}

/** Estimated memory of one warm lane for a room of this size. */
export function laneBytes(size: number): number {
  const [w, h] = SIZE_DIMS[size] ?? SIZE_DIMS[SIZE_DIMS.length - 1];
  return LANE_FIXED_BYTES + w * h * LANE_BYTES_PER_CELL;
}

export interface Verified {
  tick: number;
  hash: bigint;
  rawLength: number;
  /** True if the restore had no cached world for the snapshot's seed and config, so it regenerated (the slow path). */
  cold?: boolean;
}

/** Which worker ran a verify: the room's own warm lane, or the overflow worker (no lane: budget, start-up, no room). */
export type VerifyPath = "lane" | "overflow";

export type CheckResult =
  | { kind: "ok"; v: Verified; path?: VerifyPath }
  | { kind: "refused"; stage?: string; error?: string; path?: VerifyPath }
  | { kind: "unavailable"; why?: "timeout" | "crashed" | "closed"; path?: VerifyPath };
const UNAVAILABLE: CheckResult = { kind: "unavailable" };

interface Reply {
  id?: number;
  warmed?: boolean;
  ok?: boolean;
  tick?: number;
  hash?: bigint;
  rawLength?: number;
  cold?: boolean;
  stage?: string;
  error?: string;
}

interface Job {
  resolve: (v: CheckResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * One worker and its outstanding jobs. A timeout kills this worker only and fails only its jobs, so one room's hung
 * verify no longer costs every other room its warm world. `oneShot` (the overflow worker) terminates as soon as it has
 * nothing pending, so a room without a lane never leaves a world of memory behind.
 */
class Lane {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Job>();
  /** True from opening until the worker reports the room's world generated. */
  private warming = false;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Released while a verify was in flight: terminate once it answers. */
  private draining = false;
  private readonly owner: SnapshotVerifier;
  readonly path: VerifyPath;
  readonly room: VerifyRoom | null;
  readonly bytes: number;
  private readonly oneShot: boolean;
  constructor(owner: SnapshotVerifier, path: VerifyPath, room: VerifyRoom | null, bytes: number, oneShot: boolean) {
    this.owner = owner;
    this.path = path;
    this.room = room;
    this.bytes = bytes;
    this.oneShot = oneShot;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.owner.workerUrl, { workerData: { wasm: this.owner.bytes } });
    w.on("message", (m: Reply) => {
      if (this.worker !== w) return;
      if (m.warmed) {
        this.warming = false;
        if (this.warmTimer) clearTimeout(this.warmTimer);
        this.warmTimer = null;
        for (const [id, j] of this.pending) if (!j.timer) j.timer = this.arm(id, w);
        this.idle(w);
        return;
      }
      const j = m.id === undefined ? undefined : this.pending.get(m.id);
      if (!j) return;
      this.pending.delete(m.id!);
      if (j.timer) clearTimeout(j.timer);
      if (m.ok && m.cold) this.owner.coldRestores++;
      // The worker answered: either it restored the snapshot, or this build refused it.
      j.resolve(
        m.ok
          ? { kind: "ok", v: { tick: m.tick!, hash: m.hash!, rawLength: m.rawLength!, cold: !!m.cold }, path: this.path }
          : { kind: "refused", stage: m.stage, error: m.error, path: this.path },
      );
      this.idle(w);
    });
    // A crashed worker fails its outstanding jobs. Only the current worker counts: a worker this lane already killed
    // (timeout, release) exits later, and must not fail jobs a newer worker of the overflow lane has since taken.
    const dead = () => {
      if (this.worker !== w) return;
      this.worker = null;
      this.lost("crashed");
    };
    w.on("error", dead);
    w.on("exit", dead);
    w.unref(); // an idle worker must not keep the process alive
    this.worker = w;
    if (this.room) {
      // Generate the room's world now, so its first verify finds the base built (the worker's queue orders this
      // before any job). Seed and config are the server's own, from the room row: an upload never chooses them.
      this.warming = true;
      this.warmTimer = setTimeout(() => {
        if (this.worker !== w || !this.warming) return;
        this.owner.timeouts++;
        this.kill("timeout");
      }, this.owner.warmTimeoutMs);
      this.warmTimer.unref();
      w.ref(); // a generation in progress is work in progress, like a pending job
      w.postMessage({ prewarm: true, seed: this.room.seed, cfg: this.room.cfg });
    }
    return w;
  }

  /** Open the worker and, for a lane, start generating the room's world. */
  open(): void {
    this.start();
  }

  private arm(id: number, w: Worker): ReturnType<typeof setTimeout> {
    // A hung worker never answers and never exits: kill it and fail everything waiting on it in this lane, so one
    // stuck job cannot block later snapshots. Other lanes keep their workers and their warm worlds.
    const t = setTimeout(() => {
      if (!this.pending.has(id) || this.worker !== w) return;
      this.owner.timeouts++;
      this.kill("timeout");
    }, this.owner.timeoutMs);
    t.unref();
    return t;
  }

  /**
   * A pending job or a generation must keep the process alive; an idle worker must not. Start-up awaits a check on a
   * sim-build change before the HTTP server listens, and with the worker unref'd nothing else held the event loop, so
   * Node exited mid-wait (exit code 13, "unsettled top-level await") and the deploy crash-looped. Found by a merge
   * rehearsal on the real image; vitest keeps its own loop alive, so no test could see it.
   */
  private idle(w: Worker): void {
    if (this.pending.size > 0 || this.warming) w.ref();
    else if (this.oneShot || this.draining) this.kill("closed");
    else w.unref();
  }

  /** The worker is gone (crash or timeout): fail its jobs; a lane is retired so the room's next verify opens a fresh one. */
  private lost(why: "timeout" | "crashed" | "closed"): void {
    this.warming = false;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    for (const [id, j] of this.pending) {
      this.pending.delete(id);
      if (j.timer) clearTimeout(j.timer);
      j.resolve({ kind: "unavailable", why, path: this.path });
    }
    if (!this.oneShot) this.owner.retire(this, why);
  }

  check(compressed: Uint8Array, maxRaw: number): Promise<CheckResult> {
    return new Promise((resolve) => {
      const id = this.owner.nextId++;
      const w = this.start();
      // While the room's world is still generating, the job's own clock has not started (`LANE_WARM_TIMEOUT_MS` bounds the wait).
      this.pending.set(id, { resolve, timer: this.warming ? null : this.arm(id, w) });
      w.ref();
      w.postMessage({ id, data: compressed, maxRaw });
    });
  }

  /** Terminate once nothing is pending (now, if nothing is). */
  drain(): void {
    this.draining = true;
    if (this.pending.size === 0) this.kill("closed");
    else this.warming = false; // a released room's lane stops waiting on its generation as a reason to stay
  }

  /** Terminate the worker now, failing anything still pending. */
  kill(why: "timeout" | "crashed" | "closed"): void {
    const w = this.worker;
    this.worker = null;
    void w?.terminate();
    this.lost(why);
  }
}

export class SnapshotVerifier {
  /** @internal shared with `Lane` */
  readonly bytes: Uint8Array;
  /** @internal shared with `Lane` */
  readonly workerUrl: URL;
  /** @internal shared with `Lane` */
  nextId = 1;
  /** @internal shared with `Lane` */
  readonly timeoutMs: number;
  /** @internal shared with `Lane` */
  readonly warmTimeoutMs: number;
  private closed = false;
  private readonly budget: number;
  private readonly memoryBytes?: () => number | undefined;
  private readonly memoryCapBytes: number;
  private readonly log?: EventLog;
  /** Warm lanes by world id. */
  private readonly lanes = new Map<number, Lane>();
  /** Rooms whose lane timed out: no new lane until the room is released (empties or unloads), so a world too slow to
   *  generate in time is not regenerated over and over. They verify on the overflow worker, as before D-214. */
  private readonly barred = new Set<number>();
  /** Rooms without a lane, and start-up checks: a one-shot worker, cold every time, as every verify was before D-214. */
  private readonly overflow: Lane;
  /** Workers killed for exceeding a timeout (telemetry and tests). */
  timeouts = 0;
  /** Verifies whose restore regenerated the world (telemetry and tests: a warm lane keeps this flat). */
  coldRestores = 0;

  constructor(
    wasmPath: string,
    opts: {
      timeoutMs?: number;
      warmTimeoutMs?: number;
      workerUrl?: URL;
      /** Total estimated bytes of warm lanes (default `VERIFY_WARM_BUDGET_BYTES`); 0 disables lanes. */
      warmBudgetBytes?: number;
      /** Current memory (main.ts: the cgroup's `memory.current`); undefined skips the check. */
      memoryBytes?: () => number | undefined;
      /** No lane opens if it would take `memoryBytes()` past this (main.ts: the room-load gate's cap). */
      memoryCapBytes?: number;
      log?: EventLog;
    } = {},
  ) {
    this.bytes = new Uint8Array(readFileSync(wasmPath));
    this.timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    // An overridden job timeout scales the warm-up bound with it (the default ratio, 12x), so a test that shortens the
    // job timeout to catch a hung worker is not left waiting the production 120 s on a warm-up that never answers.
    this.warmTimeoutMs = opts.warmTimeoutMs ?? (this.timeoutMs * LANE_WARM_TIMEOUT_MS) / VERIFY_TIMEOUT_MS;
    this.workerUrl = opts.workerUrl ?? new URL("./verify-worker.ts", import.meta.url);
    this.budget = opts.warmBudgetBytes ?? VERIFY_WARM_BUDGET_BYTES;
    this.memoryBytes = opts.memoryBytes;
    this.memoryCapBytes = opts.memoryCapBytes ?? Infinity;
    this.log = opts.log;
    this.overflow = new Lane(this, "overflow", null, 0, true);
  }

  /** Estimated bytes held by open lanes. */
  laneBytesInUse(): number {
    let n = 0;
    for (const l of this.lanes.values()) n += l.bytes;
    return n;
  }

  /** World ids that hold a warm lane (tests, telemetry). */
  laneIds(): number[] {
    return [...this.lanes.keys()];
  }

  /**
   * Give this room a warm lane if it has none and one fits, and start generating its world. Called when a room gets its
   * first member, so the generation runs while the room plays rather than inside its first verify. Returns whether the
   * room has a lane. Never fails anything: a room without a lane verifies cold on the overflow worker.
   */
  warm(room: VerifyRoom): boolean {
    if (this.closed || this.barred.has(room.id)) return false;
    if (this.lanes.has(room.id)) return true;
    const need = laneBytes(room.size);
    const inUse = this.laneBytesInUse();
    const mem = this.memoryBytes?.();
    if (inUse + need > this.budget || (mem !== undefined && mem + need > this.memoryCapBytes)) {
      this.log?.limited("verify:lane_refused", 10_000, "verify.lane_refused", {
        world: room.id,
        need_mb: Math.round(need / 1048576),
        in_use_mb: Math.round(inUse / 1048576),
        budget_mb: Math.round(this.budget / 1048576),
        cgroup_mb: mem === undefined ? null : Math.round(mem / 1048576),
      });
      return false;
    }
    const lane = new Lane(this, "lane", room, need, false);
    this.lanes.set(room.id, lane);
    lane.open();
    this.log?.event("verify.lane_opened", { world: room.id, size: room.size, est_mb: Math.round(need / 1048576), lanes: this.lanes.size, in_use_mb: Math.round((inUse + need) / 1048576) });
    return true;
  }

  /**
   * The room emptied or unloaded: terminate its lane (after an in-flight verify answers, so the last snapshot before
   * everyone left is not lost), which gives its memory back now. A rejoin opens a fresh lane.
   */
  release(id: number): void {
    this.barred.delete(id);
    const lane = this.lanes.get(id);
    if (!lane) return;
    this.lanes.delete(id);
    lane.drain();
    this.log?.event("verify.lane_closed", { world: id, reason: "released", lanes: this.lanes.size });
  }

  /** @internal A lane whose worker crashed or timed out: forget it. A timed-out room gets no new lane until released. */
  retire(lane: Lane, why: "timeout" | "crashed" | "closed"): void {
    const id = lane.room?.id;
    if (id === undefined || this.lanes.get(id) !== lane) return; // already released
    this.lanes.delete(id);
    if (why === "timeout") this.barred.add(id);
    this.log?.limited(`verify:lane_lost:${id}`, 10_000, "verify.lane_closed", { world: id, reason: why, lanes: this.lanes.size }, "warn");
  }

  /** Decompress (capped at `maxRaw`), restore and hash. Null if the data is bad or the sim refuses it. */
  hashOf(compressed: Uint8Array, maxRaw: number, room?: VerifyRoom): Promise<Verified | null> {
    return this.check(compressed, maxRaw, room).then((r) => (r.kind === "ok" ? r.v : null));
  }

  /**
   * Like `hashOf`, but tells a snapshot this build refuses ("refused": the worker ran and could not restore it)
   * apart from a verification that never finished ("unavailable": timeout, crash, closed). Start-up must only
   * throw a world away for the first: a slow worker on a busy machine is no reason to reset (D-014).
   *
   * With `room`, the verify runs on the room's warm lane (opening one if it fits); without one, or if none fits, on the
   * overflow worker. The worker job is the same either way: the lane decides only whether the world is regenerated.
   */
  check(compressed: Uint8Array, maxRaw: number, room?: VerifyRoom): Promise<CheckResult> {
    if (this.closed) return Promise.resolve(UNAVAILABLE);
    const lane = room && this.warm(room) ? this.lanes.get(room.id)! : this.overflow;
    return lane.check(compressed, maxRaw);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const l of this.lanes.values()) l.kill("closed");
    this.lanes.clear();
    this.overflow.kill("closed");
  }
}
