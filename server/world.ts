// One world (sandbox or game): connected clients, player ids, the closed-tick log, the tick clock, hash
// checks, snapshots and persistence. Each world has its own clock, log and snapshots. Never steps the sim
// (invariant 11); the only sim use is SnapshotVerifier.restore, which runs in a worker thread.
import { KIND_JOIN, KIND_LEAVE } from "../shared/inputs.ts";
import { GAME_H, GAME_W, maxPosJump, POS_ONE, POS_PAYLOAD_LEN } from "../shared/avatar.ts";
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
import type { SnapshotVerifier } from "./verify.ts";

export const SANDBOX_SEED = 1n;
/** The game world's seed. Fixed so every deploy regenerates the same world from the stored row. */
export const GAME_SEED = 20261014n;
export const SANDBOX_ID = 0;
export const GAME_ID = 1;
/** World 0 is the sandbox and world 1 the game world (HELLO's world_id picks one). */
export const worldKindOf = (id: number): number | null => (id === SANDBOX_ID ? WORLD_SANDBOX : id === GAME_ID ? WORLD_GAME : null);
/** With no verified snapshot the whole log stays in memory; this bounds it (about 55 minutes). */
export const MAX_LOG_TICKS = 200_000;
/** Drop a client whose socket send queue grows past this: it is not keeping up. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const HASH_WAIT_MS = 2000;
export const FLUSH_EVERY_MS = 1000;
export const SNAPSHOT_EVERY_TICKS = 1800;
/** A requested snapshot tick is at least this far ahead of the clock. */
export const SNAPSHOT_LEAD_TICKS = 120;
/** Give up on a snapshot request this many ticks after its tick. */
const SNAPSHOT_GIVE_UP_TICKS = 600;

export interface Peer {
  send(frame: Uint8Array): void;
  /** Bytes queued but not yet written to the socket. */
  buffered(): number;
  close(code: number, reason: string): void;
  userAgent?: string;
}

interface Member {
  /** Connection id: unique per connection. The sandbox uses it as the sim's player id too. */
  id: number;
  /** The sim player id this connection controls; 0 for a spectator (no Join was stamped). */
  playerId: number;
  peer: Peer;
  /** Connection order: lower means connected longer. */
  seq: number;
  /** Display name, already trimmed and capped; render-only. */
  name: string;
  /** HASH for ticks at or below this are ignored (they predate the client's current sim). */
  minHashTick: number;
  lastBadTick: number;
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
  log?: (msg: string) => void;
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
  readonly stats: WorldStats = { snapshotsAccepted: 0, snapshotsRejected: 0, resyncs: 0, incidents: 0, flushes: 0, posRejected: 0, lastVerifyMs: 0 };
  closing = false;
  /** Test and telemetry hook: called after each closed tick has been broadcast. */
  onTickClosed: ((tick: number) => void) | null = null;

  private readonly now: () => number;
  private readonly db?: GameDb;
  private readonly verifier?: SnapshotVerifier;
  private readonly simBuild: string;
  private readonly snapshotEvery: number;
  private readonly say: (m: string) => void;
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
  /** Last accepted Pos per sim player, kept across reconnects within this process (the baseline for plan 7.6). */
  private readonly lastPosOf = new Map<number, { x: number; y: number; tick: number }>();

  constructor(opts: WorldOptions) {
    this.id = opts.id ?? SANDBOX_ID;
    this.kind = worldKindOf(this.id) ?? WORLD_SANDBOX;
    this.seed = this.id === GAME_ID ? GAME_SEED : SANDBOX_SEED;
    this.now = opts.now;
    this.db = opts.db;
    this.verifier = opts.verifier;
    this.simBuild = opts.simBuild ?? "";
    this.snapshotEvery = opts.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS;
    this.say = opts.log ?? (() => {});
    this.clock = new TickClock(opts.now, (t) => this.onClosed(t), TICK_HZ);
    this.lastFlush = opts.now();
  }

  get playerCount(): number {
    return this.members.size;
  }

  get full(): boolean {
    return this.log.length >= MAX_LOG_TICKS;
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
      if (snap && this.verifier) {
        ok = (await this.verifier.hashOf(snap.data, maxSnapshotRawFor(this.kind)))?.tick === snap.tick;
      }
      if (ok && snap) {
        db.clearTickLog(this.id);
        db.setWorldBuild(this.id, this.simBuild);
        this.say(`[world] sim build changed: kept snapshot at tick ${snap.tick}, dropped the old log`);
      } else {
        db.resetWorld(this.id, this.simBuild);
        snap = null;
        this.say("[world] sim build changed and the snapshot cannot be restored: world reset");
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
    this.log.push(...frames);
    // Who the restored state says is active: the snapshot's players, then the logged Joins and Leaves (S4).
    const stillActive = this.kind === WORLD_GAME ? activeAfter(snap ? activePlayersIn(snap.data) : new Set<number>(), frames) : new Set<number>();
    this.snapshotOnline = this.kind === WORLD_GAME ? (snap ? activePlayersIn(snap.data).size : 0) : Math.max(0, -net);
    this.online = this.kind === WORLD_GAME ? this.snapshotOnline + net : 0;
    this.clock.setClosed(base + frames.length);
    this.lastRequestTick = base;
    if (rewrite) {
      this.say(`[world] tick_log was not contiguous after tick ${base}; kept ${frames.length} ticks`);
      db.clearTickLog(this.id);
      if (frames.length) {
        this.pendingFirst = base + 1;
        this.pending = frames.slice();
      }
    }
    this.leaveOrphans(stillActive);
    this.say(`[world] loaded: snapshot ${snap ? snap.tick : "none"}, ${frames.length} logged ticks, resuming at tick ${base + frames.length}`);
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
    this.say(`[world ${this.id}] cold start: stamped Leave for ${ids.size} player(s) left active by a crash`);
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
      this.say(`[world] tick_log flush failed, will retry: ${String(e)}`);
    }
  }

  // ---- join, leave, input -------------------------------------------------------------------------

  /**
   * Admit a peer: WELCOME, then the latest verified snapshot (if any), then every closed tick after it, then
   * live. All in one synchronous run, so no tick can fall between. In the game world `playerId` is the stable
   * id from the players table (the same person always controls the same entity); a spectator (`playerId` 0)
   * gets no Join and no avatar. The sandbox hands out ids from a counter, as before. Returns the connection id.
   */
  join(peer: Peer, opts: { playerId?: number; name?: string; spectate?: boolean } = {}): { conn: number; playerId: number } {
    this.clock.resume();
    this.clock.advance();
    const spectate = !!opts.spectate && this.kind === WORLD_GAME;
    // One connection per game-world player: a second tab or a reload replaces the first. The old one is
    // dropped without a Leave, because the Join stamped below keeps the entity active.
    const prior = !spectate && this.kind === WORLD_GAME && opts.playerId ? this.connOf(opts.playerId) : null;
    if (prior !== null) {
      const old = this.members.get(prior);
      this.members.delete(prior);
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
    this.sendCatchUp(peer, (base) => encodeWelcome(playerId, this.seed, this.kind, TICK_HZ, this.clock.lastClosed, base));
    for (const [id, name] of names) this.trySend(peer, encodePlayerName(id, name));
    this.members.set(conn, {
      id: conn,
      playerId,
      name: opts.name ?? "",
      peer,
      seq: conn,
      minHashTick: this.clock.lastClosed,
      lastBadTick: 0,
    });
    if (playerId) {
      this.stamp({ player: playerId, kind: KIND_JOIN, payload: new Uint8Array(0) });
      if (opts.name) this.broadcastName(conn, playerId, opts.name);
    }
    return { conn, playerId };
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

  private sendCatchUp(peer: Peer, header: (playersAtBase: number) => Uint8Array): void {
    const base = this.snapshot ? (this.onlineAt.get(this.snapshot.tick) ?? this.snapshotOnline) : 0;
    if (!this.trySend(peer, header(base))) return;
    const sf = this.snapshotFrame();
    if (sf && !this.trySend(peer, sf)) return;
    for (const f of this.log) if (!this.trySend(peer, f)) return;
  }

  leave(conn: number): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    if (m.playerId) this.stamp({ player: m.playerId, kind: KIND_LEAVE, payload: new Uint8Array(0) });
    if (this.request?.memberId === conn) this.request = null;
    if (this.waitingUpload?.memberId === conn) this.waitingUpload = null;
    if (this.members.size === 0) {
      // Last one out. The sim is not ours to snapshot and the client is gone, so nothing to ask: the
      // next cold start replays the log since the last snapshot. Close the Leave tick and persist it now.
      this.clock.pause();
      this.clock.closeNow();
      this.checkpoints.clear();
      this.request = null;
      this.waitingUpload = null;
      this.flush();
    }
  }

  /**
   * Plan 7.6: accept a game-world Pos only if it stays within what the avatar controller and one knockback can
   * cover since the last accepted Pos of that player. `payload` is the sim's Pos minus kind and player.
   * The first Pos of a session (and the first after a respawn changes `life`) has no baseline: it is accepted
   * if it is inside the world, because the server cannot read the entity's position without the sim.
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
    // Compared whatever `life` the client claims: `life` is the client's word, and trusting it would let a
    // cheater dodge the check by changing it. (M5: a real respawn must reset this baseline.)
    void life;
    const last = this.lastPosOf.get(m.playerId);
    if (last) {
      const limit = maxPosJump(openTick - last.tick);
      if (Math.abs(x - last.x) > limit || Math.abs(y - last.y) > limit) return bad();
    }
    this.lastPosOf.set(m.playerId, { x, y, tick: openTick });
    return true;
  }

  stamp(input: TickInput): number {
    return this.clock.stamp(input);
  }

  /** Called from the server's timer. */
  tick(): void {
    this.clock.advance();
    if (this.clock.isPaused) return;
    const t = this.now();
    if (this.db && t - this.lastFlush >= FLUSH_EVERY_MS) {
      this.lastFlush = t;
      this.flush();
    }
    this.resolveDue(t);
    this.maybeRequestSnapshot();
  }

  /** SIGTERM path: stop taking inputs, close the open tick, write everything. */
  shutdown(): void {
    this.closing = true;
    for (const id of [...this.members.keys()]) this.leave(id);
    this.clock.closeNow();
    this.flush();
  }

  // ---- hash checks (plan 7.4) -----------------------------------------------------------------

  onHash(memberId: number, tick: number, hash: bigint): void {
    const m = this.members.get(memberId);
    if (!m || tick % HASH_EVERY !== 0 || tick <= m.minHashTick || tick > this.clock.lastClosed) return;
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
    this.checkUpload(tick);
  }

  private diverged(tick: number, truth: bigint, bad: Map<number, bigint>, all?: Map<number, bigint>): void {
    const members = [...bad.keys()].map((id) => this.members.get(id)).filter((m): m is Member => !!m);
    this.stats.incidents++;
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
    this.say(`[world] desync at tick ${tick}: players ${[...bad.keys()].join(",")} resynced`);
  }

  /** Latest verified snapshot plus every closed tick after it, through the same path as a late join. */
  private resync(m: Member): void {
    this.stats.resyncs++;
    m.minHashTick = this.clock.lastClosed;
    for (const cp of this.checkpoints.values()) cp.hashes.delete(m.id);
    if (this.waitingUpload?.memberId === m.id) this.waitingUpload = null;
    if (this.request?.memberId === m.id) this.request = null;
    this.sendCatchUp(m.peer, (base) => encodeResync(this.clock.lastClosed, base));
  }

  // ---- snapshots (plan 7.5) -----------------------------------------------------------------------

  private maybeRequestSnapshot(): void {
    const last = this.clock.lastClosed;
    if (this.request) {
      if (last > this.request.tick + SNAPSHOT_GIVE_UP_TICKS) {
        this.say(`[world] snapshot ${this.request.tick} never arrived; giving up`);
        this.request = null;
        this.waitingUpload = null;
      }
      return;
    }
    if (last - this.lastRequestTick < this.snapshotEvery) return;
    this.requestSnapshot();
  }

  /** Ask the longest-connected client that has not disagreed recently for a snapshot at a future tick. */
  requestSnapshot(): boolean {
    if (this.request || !this.db) return false;
    const last = this.clock.lastClosed;
    let ref: Member | null = null;
    for (const m of this.members.values()) {
      if (last - m.lastBadTick < 3 * this.snapshotEvery && m.lastBadTick) continue;
      if (!ref || m.seq < ref.seq) ref = m;
    }
    if (!ref) return false;
    const tick = Math.ceil((last + SNAPSHOT_LEAD_TICKS) / HASH_EVERY) * HASH_EVERY;
    this.request = { tick, memberId: ref.id, at: this.now() };
    this.lastRequestTick = last;
    ref.peer.send(encodeRequestSnapshot(tick));
    return true;
  }

  /** True if this member is the one we asked for a snapshot at `tick`. */
  expectsUpload(memberId: number, tick: number): boolean {
    return this.request?.memberId === memberId && this.request.tick === tick && !this.waitingUpload;
  }

  /** Verify an upload once the majority hash for its tick is known; until then hold it. */
  onUpload(memberId: number, tick: number, claimed: bigint, data: Uint8Array): void {
    if (!this.expectsUpload(memberId, tick)) return;
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
      this.say(`[world ${this.id}] snapshot ${tick} rejected: ${why}`);
    };
    if (!this.verifier || !this.db) return reject("no verifier");
    if (u.hash !== truth) return reject("uploader's claimed hash differs from the majority hash");
    // Decompress, restore and hash in a worker thread: restoring a game world regenerates it (about 400 ms),
    // which on this thread would stall every closed tick. The tick clock keeps running while this awaits.
    const t0 = this.now();
    this.verifying = true;
    void this.verifier
      .hashOf(u.data, maxSnapshotRawFor(this.kind))
      .then((got) => {
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
        this.say(`[world ${this.id}] snapshot ${tick} verified in ${this.stats.lastVerifyMs.toFixed(0)} ms: ${u.data.length} bytes compressed, ${got.rawLength} raw`);
      })
      .catch((e) => {
        // A failed save (disk full) is a lost snapshot, not a dead process: the log keeps growing and the
        // next request tries again.
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
