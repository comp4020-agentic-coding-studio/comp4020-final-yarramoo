// One sandbox world: connected clients, player ids, the closed-tick log, the tick clock, hash checks,
// snapshots and persistence. Never steps the sim (invariant 11); the only sim use is SnapshotVerifier.restore.
import { KIND_JOIN, KIND_LEAVE } from "../shared/inputs.ts";
import {
  decompressSnapshot,
  encodeRequestSnapshot,
  encodeResync,
  encodeSnapshot,
  encodeTick,
  encodeWelcome,
  HASH_EVERY,
  splitTickFrames,
  TICK_HZ,
  type TickInput,
} from "../shared/protocol.ts";
import { TickClock, type ClosedTick } from "./clock.ts";
import type { GameDb } from "./db.ts";
import type { SnapshotVerifier } from "./verify.ts";

export const SANDBOX_SEED = 1n;
export const WORLD_KIND = 0;
export const WORLD_ID = 0;
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
  id: number;
  peer: Peer;
  /** Connection order: lower means connected longer. */
  seq: number;
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
}

export class World {
  readonly seed = SANDBOX_SEED;
  readonly kind = WORLD_KIND;
  /** log[i] is the encoded TICK frame for tick logBase + 1 + i: only ticks after the latest verified snapshot. */
  readonly log: Uint8Array[] = [];
  logBase = 0;
  /** Latest verified snapshot (compressed, as uploaded). */
  snapshot: { tick: number; data: Uint8Array } | null = null;
  readonly members = new Map<number, Member>();
  readonly clock: TickClock;
  readonly stats: WorldStats = { snapshotsAccepted: 0, snapshotsRejected: 0, resyncs: 0, incidents: 0, flushes: 0 };
  closing = false;

  private readonly now: () => number;
  private readonly db?: GameDb;
  private readonly verifier?: SnapshotVerifier;
  private readonly simBuild: string;
  private readonly snapshotEvery: number;
  private readonly say: (m: string) => void;
  private nextPlayer = 1;
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
  private lastRequestTick = 0;

  constructor(opts: WorldOptions) {
    this.now = opts.now;
    this.db = opts.db;
    this.verifier = opts.verifier;
    this.simBuild = opts.simBuild ?? "";
    this.snapshotEvery = opts.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS;
    this.say = opts.log ?? (() => {});
    this.clock = new TickClock(opts.now, (t) => this.onClosed(t), TICK_HZ);
    this.lastFlush = opts.now();
    if (this.db) this.loadFromDb(this.db);
  }

  get playerCount(): number {
    return this.members.size;
  }

  get full(): boolean {
    return this.log.length >= MAX_LOG_TICKS;
  }

  // ---- cold start (plan 9.2, D-004) -------------------------------------------------------------

  private loadFromDb(db: GameDb): void {
    const row = db.getWorld(WORLD_ID);
    if (!row) {
      db.createWorld(WORLD_ID, "sandbox", this.seed, this.simBuild);
      return;
    }
    this.nextPlayer = Math.max(1, row.nextPlayer);
    let snap = db.latestSnapshot(WORLD_ID);
    if (row.simBuild !== this.simBuild) {
      // New sim build (plan 9.3): the logged inputs cannot be replayed under new rules. Keep the snapshot if this
      // build can restore it, start a fresh log; otherwise start the world over.
      let ok = false;
      if (snap && this.verifier) {
        try {
          ok = this.verifier.hashOf(decompressSnapshot(snap.data))?.tick === snap.tick;
        } catch {
          ok = false;
        }
      }
      if (ok && snap) {
        db.clearTickLog(WORLD_ID);
        db.setWorldBuild(WORLD_ID, this.simBuild);
        this.say(`[world] sim build changed: kept snapshot at tick ${snap.tick}, dropped the old log`);
      } else {
        db.resetWorld(WORLD_ID, this.simBuild);
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
    scan: for (const b of db.ticksAfter(WORLD_ID, base)) {
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
    if (frames.length === 0 && db.ticksAfter(WORLD_ID, base).length > 0) rewrite = true;
    // Not push(...frames): spreading ~130k+ ticks as arguments overflows the stack, and the app crashed on boot.
    for (const f of frames) this.log.push(f);
    this.snapshotOnline = Math.max(0, -net);
    this.online = 0;
    this.clock.setClosed(base + frames.length);
    this.lastRequestTick = base;
    if (rewrite) {
      this.say(`[world] tick_log was not contiguous after tick ${base}; kept ${frames.length} ticks`);
      db.clearTickLog(WORLD_ID);
      if (frames.length) {
        this.pendingFirst = base + 1;
        this.pending = frames.slice();
      }
    }
    this.say(`[world] loaded: snapshot ${snap ? snap.tick : "none"}, ${frames.length} logged ticks, resuming at tick ${base + frames.length}`);
  }

  // ---- tick close, broadcast, persistence ---------------------------------------------------------

  private onClosed(t: ClosedTick): void {
    const frame = encodeTick(t.tick, t.inputs);
    this.log.push(frame);
    for (const [id, m] of this.members) {
      if (m.peer.buffered() > MAX_BUFFERED_BYTES) {
        m.peer.close(1013, "too slow");
        continue;
      }
      try {
        m.peer.send(frame);
      } catch {
        this.members.delete(id);
      }
    }
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
      this.db.appendTicks(WORLD_ID, this.pendingFirst, this.pendingFirst + this.pending.length - 1, this.simBuild, data);
      this.db.setNextPlayer(WORLD_ID, this.nextPlayer);
      this.pending = [];
      this.stats.flushes++;
    } catch (e) {
      this.say(`[world] tick_log flush failed, will retry: ${String(e)}`);
    }
  }

  // ---- join, leave, input -------------------------------------------------------------------------

  /**
   * Admit a peer: WELCOME, then the latest verified snapshot (if any), then every closed tick after it, then
   * live. All in one synchronous run, so no tick can fall between. Returns the player id.
   */
  join(peer: Peer): number {
    this.clock.resume();
    this.clock.advance();
    const id = this.nextPlayer++;
    this.sendCatchUp(peer, (base) => encodeWelcome(id, this.seed, this.kind, TICK_HZ, this.clock.lastClosed, base));
    const seq = this.nextSeq++;
    this.members.set(id, { id, peer, seq, minHashTick: this.clock.lastClosed, lastBadTick: 0 });
    this.stamp({ player: id, kind: KIND_JOIN, payload: new Uint8Array(0) });
    return id;
  }

  private sendCatchUp(peer: Peer, header: (playersAtBase: number) => Uint8Array): void {
    const base = this.snapshot ? (this.onlineAt.get(this.snapshot.tick) ?? this.snapshotOnline) : 0;
    peer.send(header(base));
    if (this.snapshot) peer.send(encodeSnapshot(this.snapshot.tick, this.snapshot.data));
    for (const f of this.log) peer.send(f);
  }

  leave(id: number): void {
    if (!this.members.delete(id)) return;
    this.stamp({ player: id, kind: KIND_LEAVE, payload: new Uint8Array(0) });
    if (this.request?.memberId === id) this.request = null;
    if (this.waitingUpload?.memberId === id) this.waitingUpload = null;
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
    this.db?.recordIncident(WORLD_ID, tick, {
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
      this.say(`[world] snapshot ${tick} rejected: ${why}`);
    };
    if (!this.verifier || !this.db) return reject("no verifier");
    if (u.hash !== truth) return reject("uploader's claimed hash differs from the majority hash");
    let raw: Uint8Array;
    try {
      raw = decompressSnapshot(u.data);
    } catch {
      return reject("does not decompress");
    }
    const got = this.verifier.hashOf(raw);
    if (!got) return reject("sim refused to restore it");
    if (got.tick !== tick) return reject("snapshot tick mismatch");
    if (got.hash !== u.hash || got.hash !== truth) return reject("restored hash differs from the claimed and majority hash");
    if (this.snapshot && tick <= this.snapshot.tick) return;
    this.db.saveSnapshot(WORLD_ID, { tick, hash: truth, simBuild: this.simBuild, data: u.data });
    this.log.splice(0, Math.max(0, tick - this.logBase));
    this.logBase = tick;
    this.snapshot = { tick, data: u.data };
    this.snapshotOnline = this.onlineAt.get(tick) ?? 0;
    this.stats.snapshotsAccepted++;
    this.say(`[world] snapshot ${tick} verified: ${u.data.length} bytes compressed, ${raw.length} raw`);
  }
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
