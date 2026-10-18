// One world (sandbox or game): connected clients, player ids, the closed-tick log, the tick clock, hash
// checks, snapshots and persistence. Each world has its own clock, log and snapshots. Never steps the sim
// (invariant 11); the only sim use is SnapshotVerifier.restore, which runs in a worker thread.
import { EventLog } from "./log.ts";
import { KIND_JOIN, KIND_LEAVE } from "../shared/inputs.ts";
import { GAME_H, GAME_W, POS_ONE, POS_PAYLOAD_LEN, PosBaselines } from "../shared/avatar.ts";
import {
  decompressSnapshot,
  encodePlayerName,
  MAX_SNAPSHOT_RAW_GAME,
  encodeRequestSnapshot,
  encodeResync,
  encodeSnapshot,
  encodeTick,
  encodeWelcome,
  HASH_EVERY,
  maxSnapshotRawFor,
  splitTickFrames,
  TICK_HZ,
  WORLD_GAME,
  WORLD_SANDBOX,
  type TickInput,
} from "../shared/protocol.ts";
import { TickClock, type ClosedTick } from "./clock.ts";
import type { GameDb } from "./db.ts";
import { ConnTiming, InputCounts, type PlayerStats } from "./stats.ts";
import { STAT_RESYNCS } from "../shared/stats.ts";
import type { SnapshotVerifier } from "./verify.ts";

export const SANDBOX_SEED = 1n;
/** The game world's seed. Fixed so every deploy regenerates the same world from the stored row. */
export const GAME_SEED = 20261014n;
export const SANDBOX_ID = 0;
export const GAME_ID = 1;
/** World 0 is the sandbox and world 1 the game world (HELLO's world_id picks one). */
export const worldKindOf = (id: number): number | null => (id === SANDBOX_ID ? WORLD_SANDBOX : id === GAME_ID ? WORLD_GAME : null);
/**
 * With no verified snapshot the whole log stays in memory (about 10 bytes per empty tick, so 200k is about 2 MB).
 * Past this many ticks the world logs `world.log_long`. It no longer refuses joins: a joiner is the only way to get
 * a snapshot taken and the log shortened (D-100).
 */
export const MAX_LOG_TICKS = 200_000;
/** The first `world.log_long` warning. */
export const WARN_LOG_TICKS = 100_000;
/** Drop a client whose socket send queue grows past this: it is not keeping up. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const HASH_WAIT_MS = 2000;
/** A death claim is accepted for a tick at most this long ago, and an open tally is dropped after this long (D-121). */
export const CLAIM_WINDOW_MS = 10_000;
export const CLAIM_WINDOW_TICKS = 10 * TICK_HZ;
export const MAX_OPEN_CLAIMS = 256;
/** Open tallies are re-checked (leavers, timeouts) at most this often, not every 4 ms timer tick. */
export const CLAIM_SWEEP_MS = 250;
const MAX_RESOLVED_DEATHS = 1024;
/** Per connection: at most this many CLAIM frames per CLAIM_RATE_MS (duplicates count). */
export const CLAIMS_PER_WINDOW = 30;
export const CLAIM_RATE_MS = 10_000;
export const FLUSH_EVERY_MS = 1000;
/**
 * The longest a member that never reports live can hold a world's clock (D-122). A world where nobody is live has
 * no one playing, so this only ever delays an empty room; a hostile client costs at most this per connection.
 */
export const CATCHUP_HOLD_MAX_MS = 120_000;
export const SNAPSHOT_EVERY_TICKS = 1800;
/** A requested snapshot tick is at least this far ahead of the clock. */
export const SNAPSHOT_LEAD_TICKS = 120;
/** Give up on a snapshot request this many ticks after its tick. */
const SNAPSHOT_GIVE_UP_TICKS = 600;
/** After a lapsed request, ask again this many ticks later (not a full cycle). Capped at one cycle, at least one tick. */
export const SNAPSHOT_RETRY_TICKS = 300;

export interface Peer {
  send(frame: Uint8Array): void;
  /** Bytes queued but not yet written to the socket. */
  buffered(): number;
  close(code: number, reason: string): void;
  userAgent?: string;
}

export interface Member {
  /** Connection id: unique per connection. The sandbox uses it as the sim's player id too. */
  id: number;
  /** The sim player id this connection controls; 0 for a spectator (no Join was stamped). */
  playerId: number;
  peer: Peer;
  /** Connection order: lower means connected longer. */
  seq: number;
  /** Display name, already trimmed and capped; render-only. Set for game-world players only (S_PLAYER_NAME). */
  name: string;
  /** The registered player id behind this connection, 0 when anonymous. Logs and stats only; never reaches the sim. */
  visitorId: number;
  /** The registered display name, "" when anonymous. Logs only: players only ever see `name`. */
  visitorName: string;
  /** What this connection has sent, for input.summary and the leave summary. Read-only for everyone else. */
  counts: InputCounts;
  /** Ping RTT and HASH timing for this connection (shared with main.ts's live entry). */
  timing: ConnTiming;
  /** HASH for ticks at or below this are ignored (they predate the client's current sim). */
  minHashTick: number;
  /** False from join or resync until the client says C_LIVE (or sends a HASH past `minHashTick`). */
  live: boolean;
  /** When this member last began catching up (join or resync), for the hold's safety valve. */
  catchupSince: number;
  lastBadTick: number;
  claimWindowStart: number;
  claimsInWindow: number;
}

/** One death that a majority of eligible clients agreed on. Ids are sim player ids, which are visitor ids in the game world. */
export interface ResolvedDeath {
  tick: number;
  victim: number;
  killer: number;
  cause: number;
  bag: number;
}

interface ClaimTally {
  death: ResolvedDeath;
  votes: Set<number>;
  firstAt: number;
}

interface Checkpoint {
  hashes: Map<number, bigint>;
  firstAt: number;
}

interface SnapshotRequest {
  tick: number;
  memberId: number;
  at: number;
}

export interface WorldOptions {
  id?: number;
  now: () => number;
  db?: GameDb;
  verifier?: SnapshotVerifier;
  /** Hex sha256 of the sim build, stored with ticks and snapshots. */
  simBuild?: string;
  snapshotEveryTicks?: number;
  /** Override MAX_LOG_TICKS and WARN_LOG_TICKS (tests). */
  maxLogTicks?: number;
  warnLogTicks?: number;
  /** Override CATCHUP_HOLD_MAX_MS (tests). */
  catchupHoldMaxMs?: number;
  log?: EventLog;
  /** Per-player counters; the world bumps `resyncs`. Optional so a bare World works in unit tests. */
  stats?: PlayerStats;
}

export interface WorldStats {
  snapshotsAccepted: number;
  snapshotsRejected: number;
  resyncs: number;
  incidents: number;
  flushes: number;
  posRejected: number;
  /** Duration of the last snapshot verification (worker round trip), ms. */
  lastVerifyMs: number;
  /** Checkpoints resolved with every reporter agreeing, and divergences found. */
  hashPasses: number;
  hashFails: number;
}

export class World {
  readonly id: number;
  seed: bigint;
  readonly kind: number;
  /** log[i] is the encoded TICK frame for tick logBase + 1 + i: only ticks after the latest verified snapshot. */
  readonly log: Uint8Array[] = [];
  logBase = 0;
  /** Latest verified snapshot (compressed, as uploaded). */
  snapshot: { tick: number; data: Uint8Array } | null = null;
  readonly members = new Map<number, Member>();
  readonly clock: TickClock;
  readonly stats: WorldStats = { snapshotsAccepted: 0, snapshotsRejected: 0, resyncs: 0, incidents: 0, flushes: 0, posRejected: 0, lastVerifyMs: 0, hashPasses: 0, hashFails: 0 };
  closing = false;
  /** True for the duration of reset(): stamp, join, onHash and onUpload refuse. */
  resetting = false;
  /** Called once per death a majority agreed on (the server turns it into stats and achievements). Never touches the sim. */
  onDeathResolved: ((d: ResolvedDeath) => void) | null = null;
  /** Test and telemetry hook: called after each closed tick has been broadcast. */
  onTickClosed: ((tick: number) => void) | null = null;

  private readonly now: () => number;
  private readonly db?: GameDb;
  private readonly verifier?: SnapshotVerifier;
  private readonly simBuild: string;
  private readonly snapshotEvery: number;
  private readonly maxLogTicks: number;
  private readonly warnLogTicks: number;
  private readonly holdMaxMs: number;
  private heldSince: number | null = null;
  /** Which of the two log-length warnings (0 none, 1 warn level, 2 cap) have fired since the log last shrank. */
  private logWarned = 0;
  private readonly elog: EventLog;
  private readonly pstats?: PlayerStats;
  private nextPlayer = 1;
  /** Members whose send failed or whose queue overflowed: they get a Leave once the tick being closed is done. */
  private readonly dropped: number[] = [];
  private snapFrame: { src: Uint8Array; frame: Uint8Array } | null = null;
  private nextSeq = 1;
  private online = 0;
  /** Players online as of tick t, for multiples of HASH_EVERY (UI presence for a client starting at a snapshot). */
  private readonly onlineAt = new Map<number, number>();
  private snapshotOnline = 0;
  private pending: Uint8Array[] = [];
  private pendingFirst = 0;
  private lastFlush = 0;
  private readonly checkpoints = new Map<number, Checkpoint>();
  private readonly truth = new Map<number, bigint>();
  private request: SnapshotRequest | null = null;
  private waitingUpload: { tick: number; memberId: number; hash: bigint; data: Uint8Array } | null = null;
  /** True while a snapshot is being verified in the worker. */
  verifying = false;
  private lastRequestTick = 0;
  /** Bumped by reset(); a snapshot verification that started under an older generation must not save. */
  private resetGen = 0;
  /** Last accepted Pos per sim player, kept across reconnects within this process (the baseline for plan 7.6). */
  private readonly lastPosOf = new Map<number, PosBaselines>();
  /** Open death claims by full key (`tick:victim:killer:cause:bag`), oldest first. */
  /** Game-world player ids that have joined in this process: the only ids a death may name (D-119). Cleared by reset. */
  private readonly seenPlayers = new Set<number>();
  private lastClaimSweep = 0;
  private readonly claims = new Map<string, ClaimTally>();
  /** `tick:victim` of deaths already resolved, so a late or conflicting claim is not counted twice. Oldest first. */
  private readonly resolvedDeaths = new Map<string, string>();

  constructor(opts: WorldOptions) {
    this.id = opts.id ?? SANDBOX_ID;
    this.kind = worldKindOf(this.id) ?? WORLD_SANDBOX;
    this.seed = this.id === GAME_ID ? GAME_SEED : SANDBOX_SEED;
    this.now = opts.now;
    this.db = opts.db;
    this.verifier = opts.verifier;
    this.simBuild = opts.simBuild ?? "";
    this.snapshotEvery = opts.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS;
    this.maxLogTicks = opts.maxLogTicks ?? MAX_LOG_TICKS;
    this.warnLogTicks = opts.warnLogTicks ?? WARN_LOG_TICKS;
    this.holdMaxMs = opts.catchupHoldMaxMs ?? CATCHUP_HOLD_MAX_MS;
    this.elog = opts.log ?? new EventLog({ quiet: true });
    this.pstats = opts.stats;
    this.clock = new TickClock(opts.now, (t) => this.onClosed(t), TICK_HZ);
    this.lastFlush = opts.now();
  }

  /** The one place a log `who` is built: `name#visitorId`, or `anon#c<conn>` when the connection has no identity. */
  whoOf(m: Member): string {
    return m.visitorId ? `${m.visitorName}#${m.visitorId}` : `anon#c${m.id}`;
  }

  whoOfConn(conn: number): string {
    const m = this.members.get(conn);
    return m ? this.whoOf(m) : `anon#c${conn}`;
  }

  /** Whether this connection is still a member (a replaced tab is not, though its socket lingers until closed). */
  hasMember(conn: number): boolean {
    return this.members.has(conn);
  }

  get playerCount(): number {
    return this.members.size;
  }

  /** True while the tick clock is held because every member is still catching up (D-122). */
  get held(): boolean {
    return this.heldSince !== null;
  }

  /**
   * Hold the clock while members exist, none is live, and at least one began catching up less than the safety
   * valve ago. Pausing only delays when ticks close: inputs stamped meanwhile wait in the clock's open tick and
   * close in arrival order on release, so nothing is dropped or reordered. Call after any change to membership
   * or to a member's `live`, and from the timer while held (for the deadline).
   */
  private evaluateHold(): void {
    const t = this.now();
    let anyLive = false;
    let deadline = 0;
    for (const m of this.members.values()) {
      if (m.live) anyLive = true;
      else deadline = Math.max(deadline, m.catchupSince + this.holdMaxMs);
    }
    // While held the deadline is fixed at the hold's start, so a stream of reconnects cannot extend it.
    const limit = this.heldSince !== null ? this.heldSince + this.holdMaxMs : deadline;
    const want = this.members.size > 0 && !anyLive && t < limit;
    if (want && this.heldSince === null) {
      this.heldSince = t;
      this.clock.pause();
      this.elog.event("world.hold", { world: this.id, tick: this.clock.lastClosed, members: this.members.size });
    } else if (!want && this.heldSince !== null) {
      const ms = Math.round(t - this.heldSince);
      this.heldSince = null;
      const reason = this.members.size === 0 ? "empty" : anyLive ? "live" : "expired";
      if (this.members.size > 0) {
        this.clock.resume();
        this.clock.advance();
      }
      this.elog.event("world.release", { world: this.id, tick: this.clock.lastClosed, ms, reason });
      if (reason === "expired") this.elog.limited(`hold_expired:${this.id}`, 60_000, "world.hold_expired", { world: this.id, ms, max_ms: this.holdMaxMs }, "warn");
    }
  }

  /** Past the cap. Informational only: joins are still allowed, since a joiner is how a snapshot gets taken. */
  get full(): boolean {
    return this.log.length >= this.maxLogTicks;
  }

  /** `world.log_long` once at the warn length and once at the cap, re-armed when a snapshot shortens the log. */
  private checkLogLength(): void {
    const n = this.log.length;
    if (n < this.warnLogTicks) {
      this.logWarned = 0;
      return;
    }
    const level = n >= this.maxLogTicks ? 2 : 1;
    if (level <= this.logWarned) return;
    this.logWarned = level;
    this.elog.limited(`log_long:${this.id}:${level}`, 60_000, "world.log_long", { world: this.id, log_ticks: n, limit: level === 2 ? "cap" : "warn", cap: this.maxLogTicks }, "warn");
  }

  // ---- cold start (plan 9.2, D-004) -------------------------------------------------------------

  /** Cold start: restore from the database. Async because verifying a snapshot under a new build uses the worker. */
  async load(): Promise<void> {
    if (this.db) await this.loadFromDb(this.db);
  }

  private async loadFromDb(db: GameDb): Promise<void> {
    const row = db.getWorld(this.id);
    if (!row) {
      db.createWorld(this.id, this.kind === WORLD_GAME ? "game" : "sandbox", this.seed, this.simBuild);
      return;
    }
    this.seed = row.seed;
    this.nextPlayer = Math.max(1, row.nextPlayer);
    let snap = db.latestSnapshot(this.id);
    if (row.simBuild !== this.simBuild) {
      // New sim build (plan 9.3): the logged inputs cannot be replayed under new rules. Keep the snapshot if this
      // build can restore it, start a fresh log; otherwise start the world over.
      let ok = false;
      if (snap) {
        // Only a snapshot this build refuses may cost the world. A verification that never finished (a cold
        // worker timing out on a busy 256 MB machine, a crash, no verifier) says nothing about the snapshot,
        // so refuse to start and let the platform restart us with the volume untouched (D-014, review M5
        // slice 3 N2). Before this, a timeout here reset the live sandbox.
        const r = this.verifier ? await this.verifier.check(snap.data, maxSnapshotRawFor(this.kind)) : { kind: "unavailable" as const };
        if (r.kind === "unavailable") {
          this.elog.event("world.build_changed", { world: this.id, outcome: "verify_unavailable", snapshot_tick: snap.tick }, "error");
          throw new Error(`world ${this.id}: could not verify the stored snapshot under the new build; not resetting`);
        }
        ok = r.kind === "ok" && r.v.tick === snap.tick;
      }
      if (ok && snap) {
        db.clearTickLog(this.id);
        db.setWorldBuild(this.id, this.simBuild);
        this.elog.event("world.build_changed", { world: this.id, kept_snapshot_tick: snap.tick, outcome: "kept_snapshot" }, "warn");
      } else {
        db.resetWorld(this.id, this.simBuild);
        snap = null;
        this.elog.event("world.build_changed", { world: this.id, outcome: "reset" }, "warn");
      }
    }
    const base = snap ? snap.tick : 0;
    if (snap) {
      this.snapshot = { tick: snap.tick, data: snap.data };
      this.logBase = base;
    }
    // Replay set: contiguous ticks base+1.. from the persisted log.
    let net = 0;
    let rewrite = false;
    const frames: Uint8Array[] = [];
    scan: for (const b of db.ticksAfter(this.id, base)) {
      const fs = splitTickFrames(b.data);
      if (!fs) {
        rewrite = true;
        break;
      }
      for (const f of fs) {
        const tick = new DataView(f.buffer, f.byteOffset).getUint32(1, true);
        if (tick <= base + frames.length) continue; // before the snapshot, or a duplicate
        if (tick !== base + frames.length + 1) {
          rewrite = true;
          break scan;
        }
        frames.push(f.slice());
        net += presenceDelta(f);
      }
    }
    if (frames.length === 0 && db.ticksAfter(this.id, base).length > 0) rewrite = true;
    // Not push(...frames): spreading ~130k+ ticks as arguments overflows the stack, and the app crashed on boot.
    for (const f of frames) this.log.push(f);
    // Who the restored state says is active: the snapshot's players, then the logged Joins and Leaves (S4).
    const stillActive = this.kind === WORLD_GAME ? activeAfter(snap ? activePlayersIn(snap.data) : new Set<number>(), frames) : new Set<number>();
    this.snapshotOnline = this.kind === WORLD_GAME ? (snap ? activePlayersIn(snap.data).size : 0) : Math.max(0, -net);
    this.online = this.kind === WORLD_GAME ? this.snapshotOnline + net : 0;
    this.clock.setClosed(base + frames.length);
    this.lastRequestTick = base;
    if (rewrite) {
      this.elog.event("world.log_repaired", { world: this.id, after_tick: base, kept_ticks: frames.length }, "warn");
      db.clearTickLog(this.id);
      if (frames.length) {
        this.pendingFirst = base + 1;
        this.pending = frames.slice();
      }
    }
    this.leaveOrphans(stillActive);
    this.elog.event("world.loaded", { world: this.id, snapshot_tick: snap ? snap.tick : null, replayed_ticks: frames.length, tick: base + frames.length });
  }

  /**
   * A hard crash (SIGKILL, OOM, a lost machine) leaves Joins in the log with no Leave, and nobody is connected after
   * a cold start, so those players would stay active forever, waking their region for everyone (review M4a S4, D-069).
   * Stamp a Leave for each, close that tick now and persist it: it is an ordinary input, so every client agrees.
   */
  private leaveOrphans(ids: Set<number>): void {
    if (ids.size === 0) return;
    for (const id of [...ids].sort((a, b) => a - b)) this.stamp({ player: id, kind: KIND_LEAVE, payload: new Uint8Array(0) });
    this.clock.closeNow();
    this.flush();
    this.elog.event("world.cold_start", { world: this.id, orphan_leaves: ids.size, tick: this.clock.lastClosed }, "warn");
  }

  // ---- tick close, broadcast, persistence ---------------------------------------------------------

  private onClosed(t: ClosedTick): void {
    const frame = encodeTick(t.tick, t.inputs);
    this.log.push(frame);
    for (const [id, m] of this.members) if (!this.trySend(m.peer, frame)) this.dropped.push(id);
    this.onTickClosed?.(t.tick);
    // Everything below is after the broadcast and is bookkeeping only.
    for (const i of t.inputs) {
      if (i.kind === KIND_JOIN) this.online++;
      else if (i.kind === KIND_LEAVE) this.online--;
    }
    if (t.tick % HASH_EVERY === 0) {
      this.onlineAt.set(t.tick, this.online);
      this.onlineAt.delete(t.tick - 120 * HASH_EVERY);
    }
    if (this.db) {
      if (this.pending.length === 0) this.pendingFirst = t.tick;
      this.pending.push(frame);
    }
    // Every path that removes a member stamps its Leave, so a player never stays active in the sim (S4).
    while (this.dropped.length) this.leave(this.dropped.shift()!);
  }

  /**
   * Send one frame, enforcing the queue cap at send time (review M4a S2): a slow reader is closed before it holds
   * megabytes, not only at the next tick close. False means the peer is unusable and must be dropped.
   */
  private trySend(peer: Peer, frame: Uint8Array): boolean {
    if (peer.buffered() > MAX_BUFFERED_BYTES) {
      try {
        peer.close(1013, "too slow");
      } catch {
        // already gone
      }
      return false;
    }
    try {
      peer.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  snapshotFrameForTest(): Uint8Array | null {
    return this.snapshotFrame();
  }

  /** The snapshot as one encoded frame, built once and shared by every join (not a 3 MB copy per connection). */
  private snapshotFrame(): Uint8Array | null {
    if (!this.snapshot) return null;
    if (this.snapFrame?.src !== this.snapshot.data) {
      this.snapFrame = { src: this.snapshot.data, frame: encodeSnapshot(this.snapshot.tick, this.snapshot.data) };
    }
    return this.snapFrame.frame;
  }

  /** Write the pending ticks as one tick_log row. A failure keeps them for the next try. */
  flush(): void {
    if (!this.db || this.pending.length === 0) return;
    let len = 0;
    for (const f of this.pending) len += f.length;
    const data = new Uint8Array(len);
    let o = 0;
    for (const f of this.pending) {
      data.set(f, o);
      o += f.length;
    }
    try {
      this.db.appendTicks(this.id, this.pendingFirst, this.pendingFirst + this.pending.length - 1, this.simBuild, data);
      this.db.setNextPlayer(this.id, this.nextPlayer);
      this.pending = [];
      this.stats.flushes++;
    } catch (e) {
      this.elog.event("tick_log.flush_failed", { world: this.id, pending_ticks: this.pending.length, error: String(e) }, "error");
    }
  }

  // ---- join, leave, input -------------------------------------------------------------------------

  /**
   * Admit a peer: WELCOME, then the latest verified snapshot (if any), then every closed tick after it, then
   * live. All in one synchronous run, so no tick can fall between. In the game world `playerId` is the stable
   * id from the players table (the same person always controls the same entity); a spectator (`playerId` 0)
   * gets no Join and no avatar. The sandbox hands out ids from a counter, as before. Returns the connection id.
   */
  join(peer: Peer, opts: { playerId?: number; name?: string; spectate?: boolean; visitorId?: number; visitorName?: string } = {}): { conn: number; playerId: number; who: string; counts: InputCounts; timing: ConnTiming } {
    if (this.resetting) throw new Error("world is resetting");
    // A newcomer is catching up, so with nobody live the world stays held: do not even start the clock (D-122).
    let anyLive = false;
    for (const m of this.members.values()) if (m.live) anyLive = true;
    if (anyLive) this.clock.resume();
    this.clock.advance();
    const spectate = !!opts.spectate && this.kind === WORLD_GAME;
    // One connection per game-world player: a second tab or a reload replaces the first. The old one is
    // dropped without a Leave, because the Join stamped below keeps the entity active.
    const prior = !spectate && this.kind === WORLD_GAME && opts.playerId ? this.connOf(opts.playerId) : null;
    if (prior !== null) {
      const old = this.members.get(prior);
      this.members.delete(prior);
      if (old) this.elog.event("replaced", { world: this.id, who: this.whoOf(old), conn: old.id });
      try {
        old?.peer.close(4000, "replaced by a newer connection");
      } catch {
        // already gone
      }
    }
    const playerId = spectate ? 0 : this.kind === WORLD_GAME ? (opts.playerId ?? 0) : this.nextPlayer++;
    const conn = this.nextSeq++;
    const names: [number, string][] = [];
    for (const m of this.members.values()) if (m.playerId && m.name) names.push([m.playerId, m.name]);
    const sentOk = this.sendCatchUp(peer, (base) => encodeWelcome(playerId, this.seed, this.kind, TICK_HZ, this.clock.lastClosed, base));
    for (const [id, name] of names) this.trySend(peer, encodePlayerName(id, name));
    const counts = new InputCounts();
    const timing = new ConnTiming();
    const member: Member = {
      id: conn,
      playerId,
      name: this.kind === WORLD_GAME ? (opts.name ?? "") : "",
      visitorId: opts.visitorId ?? 0,
      visitorName: opts.visitorName ?? "",
      peer,
      seq: conn,
      minHashTick: this.clock.lastClosed,
      live: false,
      catchupSince: this.now(),
      lastBadTick: 0,
      claimWindowStart: 0,
      claimsInWindow: 0,
      counts,
      timing,
    };
    this.members.set(conn, member);
    // A peer that failed during the catch-up is left at the next timer pass; a held clock would never close a tick to find out.
    if (!sentOk) this.dropped.push(conn);
    if (playerId) {
      if (this.kind === WORLD_GAME) this.seenPlayers.add(playerId);
      this.stamp({ player: playerId, kind: KIND_JOIN, payload: new Uint8Array(0) });
      if (opts.name && this.kind === WORLD_GAME) this.broadcastName(conn, playerId, opts.name);
    }
    this.evaluateHold();
    if (this.heldSince === null) {
      this.clock.resume();
      this.clock.advance();
    }
    return { conn, playerId, who: this.whoOf(member), counts, timing };
  }

  /** The connection currently controlling a game-world player, if any (a second tab or a reload replaces it). */
  connOf(playerId: number): number | null {
    for (const m of this.members.values()) if (m.playerId === playerId) return m.id;
    return null;
  }

  /** Tell everyone else (render-only; never state) who just arrived. */
  private broadcastName(conn: number, playerId: number, name: string): void {
    const f = encodePlayerName(playerId, name);
    for (const m of this.members.values()) {
      if (m.id !== conn && !this.trySend(m.peer, f)) this.dropped.push(m.id);
    }
  }

  /** False when a send failed part-way: the peer is unusable. */
  private sendCatchUp(peer: Peer, header: (playersAtBase: number) => Uint8Array): boolean {
    const base = this.snapshot ? (this.onlineAt.get(this.snapshot.tick) ?? this.snapshotOnline) : 0;
    if (!this.trySend(peer, header(base))) return false;
    const sf = this.snapshotFrame();
    if (sf && !this.trySend(peer, sf)) return false;
    for (const f of this.log) if (!this.trySend(peer, f)) return false;
    return true;
  }

  leave(conn: number): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    if (m.playerId) this.stamp({ player: m.playerId, kind: KIND_LEAVE, payload: new Uint8Array(0) });
    if (this.request?.memberId === conn) this.request = null;
    if (this.waitingUpload?.memberId === conn) this.waitingUpload = null;
    if (this.members.size === 0) {
      this.claims.clear();
      // Last one out. The sim is not ours to snapshot and the client is gone, so nothing to ask: the
      // next cold start replays the log since the last snapshot. Close the Leave tick and persist it now.
      this.clock.pause();
      this.clock.closeNow();
      this.checkpoints.clear();
      this.request = null;
      this.waitingUpload = null;
      this.evaluateHold(); // releases with reason "empty" if held; the pause above already applies
      this.flush();
    } else {
      this.evaluateHold();
    }
  }

  /**
   * Plan 7.6: accept a game-world Pos only if it stays within what the avatar controller and one knockback can
   * cover since the last accepted Pos of that player. `payload` is the sim's Pos minus kind and player.
   * The first Pos of a session, and the first after `life` changes (a respawn), has no usable baseline: it is
   * accepted if it is inside the world, because the server cannot read the entity's position without the sim.
   */
  acceptPos(conn: number, payload: Uint8Array): boolean {
    const m = this.members.get(conn);
    if (!m || !m.playerId || payload.length !== POS_PAYLOAD_LEN) return false;
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const life = v.getUint16(0, true);
    const x = v.getInt32(2, true);
    const y = v.getInt32(6, true);
    const facing = payload[10];
    const bad = () => {
      this.stats.posRejected++;
      return false;
    };
    if (facing > 1 || x < 0 || y < 0 || x >= GAME_W * POS_ONE || y >= GAME_H * POS_ONE) return bad();
    const openTick = this.clock.lastClosed + 1;
    // One baseline per life (D-078): a claimed life + 1 starts its own baseline and cannot move the real one.
    let bl = this.lastPosOf.get(m.playerId);
    if (!bl) this.lastPosOf.set(m.playerId, (bl = new PosBaselines()));
    if (!bl.accept(x, y, life, openTick)) return bad();
    return true;
  }

  stamp(input: TickInput): number {
    if (this.resetting) return 0;
    return this.clock.stamp(input);
  }

  /** Called from the server's timer. */
  tick(): void {
    // A member whose send failed is left at once, not only at the next tick close, which a held clock never reaches.
    while (this.dropped.length) this.leave(this.dropped.shift()!);
    if (this.heldSince !== null) this.evaluateHold(); // the safety valve's deadline
    this.clock.advance();
    if (this.clock.isPaused) return;
    const t = this.now();
    if (this.db && t - this.lastFlush >= FLUSH_EVERY_MS) {
      this.lastFlush = t;
      this.flush();
    }
    this.resolveDue(t);
    if (t - this.lastClaimSweep >= CLAIM_SWEEP_MS) {
      this.lastClaimSweep = t;
      this.sweepClaims(t);
    }
    this.maybeRequestSnapshot();
    this.checkLogLength();
  }

  /** SIGTERM path: stop taking inputs, close the open tick, write everything. */
  shutdown(): void {
    this.closing = true;
    for (const id of [...this.members.keys()]) this.leave(id);
    this.clock.closeNow();
    this.flush();
  }

  /**
   * Admin reset (D-097): return this world to its generated starting state. Synchronous from start to finish, so no
   * input, HASH or join can slip in between. The database is reset first: if that throws, nothing in memory has
   * changed and the world carries on as before (the transaction rolled back), so there is never a world whose
   * memory and disk disagree. Members are closed with 4001 and are NOT given Leaves (the log is being discarded);
   * they are removed from `members` first, so main.ts's finish() calling leave() later is a no-op. `nextPlayer` and
   * `nextSeq` survive so sandbox player ids and connection ids never repeat across a reset (D-039).
   */
  reset(by: string): { oldTick: number; closed: number } {
    if (this.resetting) throw new Error("reset already in progress");
    this.resetting = true;
    const oldTick = this.clock.lastClosed;
    try {
      try {
        this.db?.resetWorld(this.id, this.simBuild);
        // Persist the id counter now, so a crash before the next flush cannot hand out a pre-reset id again.
        this.db?.setNextPlayer(this.id, this.nextPlayer);
      } catch (e) {
        this.elog.event("world.reset", { world: this.id, by, old_tick: oldTick, outcome: "failed", error: String(e) }, "error");
        throw e;
      }
      const victims = [...this.members.values()];
      this.members.clear();
      for (const m of victims) {
        try {
          m.peer.close(4001, "world reset");
        } catch {
          // already gone
        }
      }
      this.resetGen++;
      this.clock.reset();
      this.evaluateHold(); // no members now: ends any hold
      this.log.length = 0;
      this.logBase = 0;
      this.snapshot = null;
      this.snapFrame = null;
      this.dropped.length = 0;
      this.online = 0;
      this.snapshotOnline = 0;
      this.onlineAt.clear();
      this.pending = [];
      this.pendingFirst = 0;
      this.lastFlush = this.now();
      this.checkpoints.clear();
      this.truth.clear();
      this.request = null;
      this.waitingUpload = null;
      this.verifying = false;
      this.lastRequestTick = 0;
      this.lastPosOf.clear();
      this.claims.clear();
      this.resolvedDeaths.clear();
      this.seenPlayers.clear();
      Object.assign(this.stats, { snapshotsAccepted: 0, snapshotsRejected: 0, resyncs: 0, incidents: 0, flushes: 0, posRejected: 0, lastVerifyMs: 0, hashPasses: 0, hashFails: 0 });
      this.elog.event("world.reset", { world: this.id, by, old_tick: oldTick, members: victims.length }, "warn");
      return { oldTick, closed: victims.length };
    } finally {
      this.resetting = false;
    }
  }

  /** C_LIVE: this member finished catching up (D-122). */
  onLive(memberId: number): void {
    const m = this.members.get(memberId);
    if (this.resetting || !m || m.live) return;
    m.live = true;
    this.evaluateHold();
  }

  // ---- hash checks (plan 7.4) -----------------------------------------------------------------

  onHash(memberId: number, tick: number, hash: bigint, stepP95Ms?: number, buffered?: number): void {
    const m = this.members.get(memberId);
    if (this.resetting || !m || tick % HASH_EVERY !== 0 || tick <= m.minHashTick || tick > this.clock.lastClosed) return;
    m.timing.lastHashTick = tick;
    if (!m.live) {
      m.live = true; // a HASH past minHashTick proves it replayed that far
      this.evaluateHold();
    }
    if (stepP95Ms !== undefined) m.timing.stepP95Ms = stepP95Ms;
    if (buffered !== undefined) m.timing.buffered = buffered;
    const known = this.truth.get(tick);
    if (known !== undefined) {
      if (known !== hash) this.diverged(tick, known, new Map([[memberId, hash]]));
      return;
    }
    let cp = this.checkpoints.get(tick);
    if (!cp) this.checkpoints.set(tick, (cp = { hashes: new Map(), firstAt: this.now() }));
    cp.hashes.set(memberId, hash);
    this.tryResolve(tick, cp, this.now());
  }

  private resolveDue(t: number): void {
    for (const [tick, cp] of this.checkpoints) this.tryResolve(tick, cp, t);
  }

  private tryResolve(tick: number, cp: Checkpoint, t: number): void {
    let waiting = false;
    for (const m of this.members.values()) if (m.minHashTick < tick && !cp.hashes.has(m.id)) waiting = true;
    if (waiting && t - cp.firstAt < HASH_WAIT_MS) return;
    this.checkpoints.delete(tick);
    // Majority; a tie goes to the group holding the longest-connected reporter.
    const groups = new Map<bigint, { n: number; best: number }>();
    for (const [id, h] of cp.hashes) {
      const seq = this.members.get(id)?.seq ?? Number.MAX_SAFE_INTEGER;
      const g = groups.get(h) ?? { n: 0, best: Number.MAX_SAFE_INTEGER };
      g.n++;
      g.best = Math.min(g.best, seq);
      groups.set(h, g);
    }
    let truth: bigint | null = null;
    let win: { n: number; best: number } | null = null;
    for (const [h, g] of groups) {
      if (!win || g.n > win.n || (g.n === win.n && g.best < win.best)) {
        win = g;
        truth = h;
      }
    }
    if (truth === null) return;
    this.truth.set(tick, truth);
    this.truth.delete(tick - 30 * HASH_EVERY);
    const bad = new Map([...cp.hashes].filter(([, h]) => h !== truth));
    if (bad.size) this.diverged(tick, truth, bad, cp.hashes);
    else this.stats.hashPasses++;
    this.checkUpload(tick);
  }

  private diverged(tick: number, truth: bigint, bad: Map<number, bigint>, all?: Map<number, bigint>): void {
    const members = [...bad.keys()].map((id) => this.members.get(id)).filter((m): m is Member => !!m);
    this.stats.incidents++;
    this.stats.hashFails++;
    // REQUEST_CHUNK_HASHES/CHUNK_HASHES to diff the diverging chunks is not built in this slice (D-043).
    this.db?.recordIncident(this.id, tick, {
      players: [...(all ?? bad).keys()],
      divergent: [...bad.keys()],
      userAgents: Object.fromEntries(members.map((m) => [m.id, m.peer.userAgent ?? null])),
      build: this.simBuild,
      truth: truth.toString(16),
      hashes: Object.fromEntries([...(all ?? bad)].map(([id, h]) => [id, h.toString(16)])),
      chunks: null,
    });
    for (const m of members) {
      m.lastBadTick = tick;
      this.resync(m);
    }
    this.elog.event("desync", { world: this.id, tick, who: members.map((m) => this.whoOf(m)).join(","), agreeing: all ? all.size - bad.size : null, uas: members.map((m) => (m.peer.userAgent ?? "").slice(0, 40)).join("|") }, "warn");
  }

  /** Latest verified snapshot plus every closed tick after it, through the same path as a late join. */
  private resync(m: Member): void {
    this.stats.resyncs++;
    m.counts.resyncs++;
    this.pstats?.bump(m.visitorId, STAT_RESYNCS);
    this.elog.event("resync", { world: this.id, who: this.whoOf(m), tick: this.clock.lastClosed }, "warn");
    m.minHashTick = this.clock.lastClosed;
    m.live = false;
    m.catchupSince = this.now();
    this.evaluateHold(); // another live member keeps the clock running
    for (const cp of this.checkpoints.values()) cp.hashes.delete(m.id);
    if (this.waitingUpload?.memberId === m.id) this.waitingUpload = null;
    if (this.request?.memberId === m.id) this.request = null;
    if (!this.sendCatchUp(m.peer, (base) => encodeResync(this.clock.lastClosed, base))) this.dropped.push(m.id);
  }

  // ---- death claims (plan 10, D-120/D-121) -------------------------------------------------------

  /**
   * One client's report of an EV_DEATH its sim emitted. The server never runs the sim, so it believes a death when at
   * least ceil(eligible / 2) distinct connections send an identical claim. Eligible means connected and past its replay
   * target at that tick (the same test as HASH). A claim is a report, never a sim input (invariant 9).
   */
  onClaim(memberId: number, claimed: ResolvedDeath): void {
    const m = this.members.get(memberId);
    if (this.resetting || !m || this.kind !== WORLD_GAME) return;
    // Only a registered visitor may vote: an anonymous socket is free, a registration is rate limited (D-119).
    if (!m.visitorId) {
      this.elog.limited(`claim_anon:${memberId}`, 10_000, "input.rejected", { world: this.id, conn: memberId, who: this.whoOf(m), reason: "claim_anonymous" }, "warn");
      return;
    }
    const t = this.now();
    if (t - m.claimWindowStart >= CLAIM_RATE_MS) {
      m.claimWindowStart = t;
      m.claimsInWindow = 0;
    }
    if (++m.claimsInWindow > CLAIMS_PER_WINDOW) {
      this.elog.limited(`claim_rate:${memberId}`, 10_000, "input.rate_limited", { world: this.id, conn: memberId, who: this.whoOf(m), limit: CLAIMS_PER_WINDOW, what: "claim" }, "warn");
      return;
    }
    // Only players this world has seen join can die or kill: a forged id must never reach player_stats (a foreign key).
    if (!this.seenPlayers.has(claimed.victim)) {
      this.elog.limited(`claim_unknown:${memberId}`, 10_000, "input.rejected", { world: this.id, conn: memberId, who: this.whoOf(m), reason: "claim_unknown_player" }, "warn");
      return;
    }
    // An unknown killer is not refused (the death is real) but is credited to nobody.
    const d: ResolvedDeath = this.seenPlayers.has(claimed.killer) ? claimed : { ...claimed, killer: 0 };
    const last = this.clock.lastClosed;
    // A future tick cannot have happened yet; an old one, or one from before this client's replay target, is not a witness.
    if (d.tick > last || d.tick < last - CLAIM_WINDOW_TICKS || d.tick <= m.minHashTick || d.tick < 1) {
      this.elog.limited(`claim_bad:${memberId}`, 10_000, "input.rejected", { world: this.id, conn: memberId, who: this.whoOf(m), reason: "claim_tick", tick: d.tick, closed: last }, "warn");
      return;
    }
    const key = `${d.tick}:${d.victim}:${d.killer}:${d.cause}:${d.bag}`;
    const won = this.resolvedDeaths.get(`${d.tick}:${d.victim}`);
    if (won !== undefined) {
      if (won !== key) this.elog.limited("claim_dissent", 10_000, "claim.unresolved", { world: this.id, tick: d.tick, victim: d.victim, reason: "dissent", who: this.whoOf(m) }, "warn");
      return;
    }
    let tally = this.claims.get(key);
    if (!tally) {
      if (this.claims.size >= MAX_OPEN_CLAIMS) this.claims.delete(this.claims.keys().next().value!);
      this.claims.set(key, (tally = { death: { ...d }, votes: new Set(), firstAt: t }));
    }
    tally.votes.add(memberId); // a Set: the same connection voting again changes nothing
    this.tryResolveClaim(key, tally);
  }

  /** Registered visitors that could have witnessed `tick`, each counted once however many connections they hold. */
  private eligibleAt(tick: number): number {
    const seen = new Set<number>();
    for (const m of this.members.values()) if (m.visitorId && m.minHashTick < tick) seen.add(m.visitorId);
    return seen.size;
  }

  /** Distinct, still-eligible visitors among `tally`'s voting connections. */
  private liveVotes(tally: ClaimTally): number {
    const seen = new Set<number>();
    for (const id of tally.votes) {
      const m = this.members.get(id);
      if (m && m.visitorId && m.minHashTick < tally.death.tick) seen.add(m.visitorId);
    }
    return seen.size;
  }

  private tryResolveClaim(key: string, tally: ClaimTally): void {
    const d = tally.death;
    const need = Math.ceil(this.eligibleAt(d.tick) / 2);
    const votes = this.liveVotes(tally);
    if (need < 1 || votes < need) return;
    // Conflicting claims for the same death mean someone desynced. Only a strictly larger group than every rival wins;
    // a tie waits for the timeout and is then dropped. (With two eligible clients one vote is a majority, so the first
    // claim wins; the dissenter is logged when its claim arrives.)
    let rival = 0;
    for (const [k, o] of this.claims) if (k !== key && o.death.tick === d.tick && o.death.victim === d.victim) rival = Math.max(rival, this.liveVotes(o));
    if (rival >= votes) return;
    const pair = `${d.tick}:${d.victim}`;
    for (const [k, o] of this.claims) {
      if (k !== key && o.death.tick === d.tick && o.death.victim === d.victim) {
        this.claims.delete(k);
        this.elog.limited("claim_conflict", 10_000, "claim.unresolved", { world: this.id, tick: d.tick, victim: d.victim, reason: "conflict", agreeing: votes, disagreeing: o.votes.size }, "warn");
      }
    }
    this.claims.delete(key);
    this.resolvedDeaths.set(pair, key);
    if (this.resolvedDeaths.size > MAX_RESOLVED_DEATHS) this.resolvedDeaths.delete(this.resolvedDeaths.keys().next().value!);
    this.onDeathResolved?.({ ...d });
  }

  /** Re-check open claims (members may have left, shrinking the quorum) and drop the ones that never reached it. */
  private sweepClaims(t: number): void {
    if (this.claims.size === 0) return;
    for (const [key, tally] of [...this.claims]) {
      if (!this.claims.has(key)) continue;
      this.tryResolveClaim(key, tally);
      if (this.claims.has(key) && t - tally.firstAt >= CLAIM_WINDOW_MS) {
        this.claims.delete(key);
        this.elog.limited("claim_unresolved", 10_000, "claim.unresolved", { world: this.id, tick: tally.death.tick, victim: tally.death.victim, votes: tally.votes.size, eligible: this.eligibleAt(tally.death.tick) }, "warn");
      }
    }
  }

  // ---- snapshots (plan 7.5) -----------------------------------------------------------------------

  private maybeRequestSnapshot(): void {
    const last = this.clock.lastClosed;
    if (this.request) {
      if (last > this.request.tick + SNAPSHOT_GIVE_UP_TICKS) {
        this.elog.event("snapshot.abandoned", { world: this.id, tick: this.request.tick, who: this.whoOfConn(this.request.memberId) }, "warn");
        this.request = null;
        this.waitingUpload = null;
        // Retry soon, not after a whole cycle: a lapse says nothing about the next live member (D-100).
        this.lastRequestTick = last - this.snapshotEvery + Math.max(1, Math.min(SNAPSHOT_RETRY_TICKS, this.snapshotEvery));
      }
      return;
    }
    if (last - this.lastRequestTick < this.snapshotEvery) return;
    this.requestSnapshot();
  }

  /** Ask the longest-connected live client that has not disagreed recently for a snapshot at a future tick. */
  requestSnapshot(): boolean {
    if (this.request || !this.db) return false;
    const last = this.clock.lastClosed;
    let ref: Member | null = null;
    for (const m of this.members.values()) {
      if (last - m.lastBadTick < 3 * this.snapshotEvery && m.lastBadTick) continue;
      // Only a live member: a replaying client sends no HASH and would ignore the request (D-100).
      const h = m.timing.lastHashTick;
      if (h === undefined || h <= m.minHashTick || last - h > 3 * HASH_EVERY) continue;
      if (!ref || m.seq < ref.seq) ref = m;
    }
    if (!ref) return false;
    const tick = Math.ceil((last + SNAPSHOT_LEAD_TICKS) / HASH_EVERY) * HASH_EVERY;
    this.request = { tick, memberId: ref.id, at: this.now() };
    this.lastRequestTick = last;
    ref.peer.send(encodeRequestSnapshot(tick));
    this.elog.event("snapshot.requested", { world: this.id, tick, from_tick: last, who: this.whoOf(ref) });
    return true;
  }

  /** True if this member is the one we asked for a snapshot at `tick`. */
  expectsUpload(memberId: number, tick: number): boolean {
    return this.request?.memberId === memberId && this.request.tick === tick && !this.waitingUpload;
  }

  /** Verify an upload once the majority hash for its tick is known; until then hold it. */
  onUpload(memberId: number, tick: number, claimed: bigint, data: Uint8Array): void {
    if (this.resetting || !this.expectsUpload(memberId, tick)) return;
    this.waitingUpload = { tick, memberId, hash: claimed, data };
    this.checkUpload(tick);
  }

  private checkUpload(tick: number): void {
    const u = this.waitingUpload;
    if (!u || u.tick !== tick) return;
    const truth = this.truth.get(tick);
    if (truth === undefined) return; // wait for the majority
    this.waitingUpload = null;
    this.request = null;
    const reject = (why: string) => {
      this.stats.snapshotsRejected++;
      this.elog.event("snapshot.rejected", { world: this.id, tick, reason: why }, "warn");
    };
    if (!this.verifier || !this.db) return reject("no verifier");
    if (u.hash !== truth) return reject("uploader's claimed hash differs from the majority hash");
    // Decompress, restore and hash in a worker thread: restoring a game world regenerates it (about 400 ms),
    // which on this thread would stall every closed tick. The tick clock keeps running while this awaits.
    const t0 = this.now();
    const gen = this.resetGen;
    this.verifying = true;
    void this.verifier
      .hashOf(u.data, maxSnapshotRawFor(this.kind))
      .then((got) => {
        if (gen !== this.resetGen) return; // the world was reset while this verified: the snapshot is from the old world
        this.verifying = false;
        this.stats.lastVerifyMs = this.now() - t0;
        if (this.closing || !this.db) return;
        if (!got) return reject("does not decompress, or the sim refused to restore it");
        if (got.tick !== tick) return reject("snapshot tick mismatch");
        if (got.hash !== u.hash || got.hash !== truth) return reject("restored hash differs from the claimed and majority hash");
        if (this.snapshot && tick <= this.snapshot.tick) return;
        this.db.saveSnapshot(this.id, { tick, hash: truth, simBuild: this.simBuild, data: u.data });
        this.log.splice(0, Math.max(0, tick - this.logBase));
        this.logBase = tick;
        this.snapshot = { tick, data: u.data };
        this.snapshotOnline = this.onlineAt.get(tick) ?? 0;
        this.stats.snapshotsAccepted++;
        this.elog.event("snapshot.accepted", { world: this.id, tick, bytes: u.data.length, raw_bytes: got.rawLength, verify_ms: Math.round(this.stats.lastVerifyMs) });
      })
      .catch((e) => {
        // A failed save (disk full) is a lost snapshot, not a dead process: the log keeps growing and the
        // next request tries again.
        if (gen !== this.resetGen) return;
        this.verifying = false;
        reject(`save failed: ${String(e)}`);
      });
  }
}

/** Active player ids in a compressed game snapshot, read from its entity section (layout in plan 6.11). */
export function activePlayersIn(compressed: Uint8Array): Set<number> {
  const out = new Set<number>();
  try {
    const raw = decompressSnapshot(compressed, MAX_SNAPSHOT_RAW_GAME);
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const ENTITY_AT = 55; // after the 55-byte header comes the entity length u32, then the entity bytes
    let o = ENTITY_AT + 4;
    const n = v.getUint32(o, true);
    o += 4;
    for (let k = 0; k < n; k++, o += 65) if (raw[o + 4] === 1) out.add(v.getUint32(o, true));
  } catch {
    // an unreadable snapshot would already have failed verification; treat as none active
  }
  return out;
}

function activeAfter(start: Set<number>, frames: Uint8Array[]): Set<number> {
  const a = new Set(start);
  for (const f of frames) {
    const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const n = v.getUint16(5, true);
    let o = 7;
    for (let k = 0; k < n; k++) {
      const kind = f[o + 4];
      const id = v.getUint32(o, true);
      if (kind === KIND_JOIN) a.add(id);
      else if (kind === KIND_LEAVE) a.delete(id);
      o += 7 + v.getUint16(o + 5, true);
    }
  }
  return a;
}

function presenceDelta(frame: Uint8Array): number {
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const n = v.getUint16(5, true);
  let o = 7;
  let d = 0;
  for (let k = 0; k < n; k++) {
    const kind = frame[o + 4];
    if (kind === KIND_JOIN) d++;
    else if (kind === KIND_LEAVE) d--;
    o += 7 + v.getUint16(o + 5, true);
  }
  return d;
}
