// Structured event log: one JSON line per event on stdout (Fly captures it), a ring buffer for the dashboard and
// tests, subscribers for live consumers (the SSE stream, later the achievement evaluator). Never reads sim state.
// Never log a raw IP or a token: use ipTag.
import { createHash, randomBytes } from "node:crypto";
import type { EventFields, EventLevel, EventName, FieldValue, LogEvent } from "../shared/events.ts";

export interface EventLogOptions {
  /** Silence stdout only; the ring buffer and subscribers still see every event (tests). */
  quiet?: boolean;
  ringSize?: number;
  /** Monotonic ms, for rate-limit windows. */
  now?: () => number;
  /** Wall clock ms, for the "t" field. */
  wallClock?: () => number;
}

export type Subscriber = (e: LogEvent) => void;

export class EventLog {
  private readonly quiet: boolean;
  private readonly ringSize: number;
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly ring: LogEvent[] = [];
  private readonly subs = new Set<Subscriber>();
  private readonly windows = new Map<string, { start: number; suppressed: number }>();
  private readonly salt = randomBytes(16);

  constructor(opts: EventLogOptions = {}) {
    this.quiet = !!opts.quiet;
    this.ringSize = opts.ringSize ?? 500;
    this.now = opts.now ?? (() => performance.now());
    this.wallClock = opts.wallClock ?? (() => Date.now());
  }

  event(ev: EventName, fields: EventFields = {}, level: EventLevel = "info"): LogEvent {
    const e: LogEvent = { t: new Date(this.wallClock()).toISOString(), lvl: level, ev };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || k === "t" || k === "lvl" || k === "ev") continue;
      e[k] = typeof v === "bigint" ? v.toString(16) : (v as FieldValue);
    }
    this.ring.push(e);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    if (!this.quiet) process.stdout.write(JSON.stringify(e) + "\n");
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must not break logging or the others
      }
    }
    return e;
  }

  /** Newest `n` events (all of them by default), oldest first. */
  recent(n?: number): LogEvent[] {
    return n === undefined ? this.ring.slice() : this.ring.slice(Math.max(0, this.ring.length - n));
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  /**
   * Rate-limited event: at most one per `everyMs` per `key`. The next emission after a quiet-or-noisy window
   * carries `suppressed: n`, the count dropped since the last emission. Returns whether it was emitted.
   */
  limited(key: string, everyMs: number, ev: EventName, fields: EventFields = {}, level: EventLevel = "info"): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (w && t - w.start < everyMs) {
      w.suppressed++;
      return false;
    }
    const suppressed = w?.suppressed ?? 0;
    this.windows.set(key, { start: t, suppressed: 0 });
    this.event(ev, suppressed > 0 ? { ...fields, suppressed } : fields, level);
    if (this.windows.size > 5000) this.sweep(t, everyMs);
    return true;
  }

  /** Forget keys whose window has long passed (connections come and go; keys must not leak). */
  private sweep(t: number, everyMs: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= everyMs && w.suppressed === 0) this.windows.delete(k);
  }

  /** Drop a key's window when its owner is gone (a closed connection). */
  forget(key: string): void {
    this.windows.delete(key);
  }

  /** Six hex characters of sha256(per-process salt + ip): enough to spot one classroom NAT, nothing more. */
  ipTag(ip: string): string {
    return createHash("sha256").update(this.salt).update(ip).digest("hex").slice(0, 6);
  }
}
