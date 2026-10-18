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

  /** Keep the largest value seen. */
  max(visitorId: number, stat: string, v: number): void {
    if (!visitorId) return;
    const m = this.of(visitorId);
    if (v <= (m.get(stat) ?? -Infinity)) return;
    m.set(stat, v);
    this.mark(visitorId, stat);
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
  /** The window since the last call, or null when the connection sent nothing in it. */
  takeWindow(): { casts: Map<string, number>; paints: Map<string, number>; pos: number; rejected: number } | null {
    const w = this.win;
    if (w.pos === 0 && w.rejected === 0 && w.casts.size === 0 && w.paints.size === 0) return null;
    this.win = { casts: new Map(), paints: new Map(), pos: 0, rejected: 0 };
    return w;
  }
}
