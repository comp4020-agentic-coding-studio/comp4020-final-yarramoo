// Per-player counters (plan 9.2: "update stats on change, batched"). Totals live in memory, loaded from
// player_stats the first time a visitor is touched; a dirty set is written in one transaction by flush().
// Never called per input to the database. visitorId 0 (anonymous) is ignored.
import type { GameDb } from "./db.ts";
import type { EventLog } from "./log.ts";

export class PlayerStats {
  private readonly totals = new Map<number, Map<string, number>>();
  private readonly dirty = new Map<number, Set<string>>();

  private readonly db: GameDb | null;
  private readonly log?: EventLog;

  constructor(db: GameDb | null, log?: EventLog) {
    this.db = db;
    this.log = log;
  }

  private of(id: number): Map<string, number> {
    let m = this.totals.get(id);
    if (!m) {
      m = new Map(this.db ? Object.entries(this.db.loadStats(id)) : []);
      this.totals.set(id, m);
    }
    return m;
  }

  private mark(id: number, stat: string): void {
    let d = this.dirty.get(id);
    if (!d) this.dirty.set(id, (d = new Set()));
    d.add(stat);
  }

  bump(visitorId: number, stat: string, n = 1): void {
    if (!visitorId || n === 0) return;
    const m = this.of(visitorId);
    m.set(stat, (m.get(stat) ?? 0) + n);
    this.mark(visitorId, stat);
  }

  /** Keep the largest value seen. Returns true when the stored value rose. */
  max(visitorId: number, stat: string, v: number): boolean {
    if (!visitorId) return false;
    const m = this.of(visitorId);
    if (v <= (m.get(stat) ?? -Infinity)) return false;
    m.set(stat, v);
    this.mark(visitorId, stat);
    return true;
  }

  get(visitorId: number): Record<string, number> {
    return visitorId ? Object.fromEntries(this.of(visitorId)) : {};
  }

  /**
   * Write every changed stat in one transaction. If the batch fails, retry row by row so one bad row (an id whose
   * player was deleted) cannot block everyone else's counters; rows that still fail stay dirty. Failures are
   * logged at most once a minute.
   */
  flush(): void {
    if (!this.db || this.dirty.size === 0) return;
    const rows: { playerId: number; stat: string; value: number }[] = [];
    for (const [id, stats] of this.dirty) for (const stat of stats) rows.push({ playerId: id, stat, value: this.totals.get(id)!.get(stat)! });
    try {
      this.db.upsertStats(rows);
      this.dirty.clear();
      return;
    } catch (e) {
      const first = String(e);
      let failed = 0;
      for (const r of rows) {
        try {
          this.db.upsertStats([r]);
          const d = this.dirty.get(r.playerId);
          d?.delete(r.stat);
          if (d?.size === 0) this.dirty.delete(r.playerId);
        } catch {
          failed++;
        }
      }
      if (failed > 0) this.log?.limited("stats.flush", 60_000, "tick_log.flush_failed", { what: "player_stats", rows: rows.length, failed, error: first }, "error");
    }
  }
}

/** RTT samples kept per connection for its p95. */
export const RTT_SAMPLES = 30;

/**
 * Network and timing figures for one connection. One object per connection, created by `World.join` and shared by
 * the member (the world writes the HASH figures) and main.ts's live entry (the ping timer writes the RTT), so
 * there is one source of truth. Never read by the sim.
 */
export class ConnTiming {
  /** Latest ws ping round trip, ms. undefined until the first pong. */
  rttMs: number | undefined;
  private readonly rtts: number[] = [];
  /** The tick of the last HASH this connection sent (undefined until its first, e.g. while catching up). */
  lastHashTick: number | undefined;
  /** The client's own step p95 (ms) and playout buffer length, as of its last HASH. */
  stepP95Ms: number | undefined;
  buffered: number | undefined;

  addRtt(ms: number): void {
    this.rttMs = ms;
    this.rtts.push(ms);
    if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
  }

  /** p95 of the last RTT_SAMPLES samples. */
  rttP95(): number | undefined {
    if (!this.rtts.length) return undefined;
    const s = [...this.rtts].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }

  /** Ticks since the last HASH. Sawtooths up to HASH_EVERY; undefined until the first HASH. */
  lag(lastClosed: number): number | undefined {
    return this.lastHashTick === undefined ? undefined : lastClosed - this.lastHashTick;
  }
}

/** What one connection has sent: a rolling window (reset by each input.summary) and the whole session. */
export class InputCounts {
  readonly casts = new Map<string, number>();
  readonly paints = new Map<string, number>();
  pos = 0;
  rejected = 0;
  maxDepth = 0;
  resyncs = 0;
  posRejected = 0;
  private win = { casts: new Map<string, number>(), paints: new Map<string, number>(), pos: 0, rejected: 0 };

  private static inc(m: Map<string, number>, k: string): void {
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  cast(spell: string): void {
    InputCounts.inc(this.casts, spell);
    InputCounts.inc(this.win.casts, spell);
  }
  paint(material: string): void {
    InputCounts.inc(this.paints, material);
    InputCounts.inc(this.win.paints, material);
  }
  position(depthCells: number): void {
    this.pos++;
    this.win.pos++;
    if (depthCells > this.maxDepth) this.maxDepth = depthCells;
  }
  reject(): void {
    this.rejected++;
    this.win.rejected++;
  }
  /** The current window without resetting it (for the dashboard). */
  peekWindow(): { casts: Map<string, number>; paints: Map<string, number>; pos: number; rejected: number } {
    return this.win;
  }
  /** The window since the last call, or null when the connection sent nothing in it. */
  takeWindow(): { casts: Map<string, number>; paints: Map<string, number>; pos: number; rejected: number } | null {
    const w = this.win;
    if (w.pos === 0 && w.rejected === 0 && w.casts.size === 0 && w.paints.size === 0) return null;
    this.win = { casts: new Map(), paints: new Map(), pos: 0, rejected: 0 };
    return w;
  }
}
