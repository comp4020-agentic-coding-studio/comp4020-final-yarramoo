// The server's event catalogue (plan: structured logging). Data only, no Node imports, so the browser
// dashboard can import it. Every server-side action logs through EventLog.event with one of these names.

export type EventLevel = "debug" | "info" | "warn" | "error";

export const EVENT_NAMES = [
  // Process
  "server.start",
  "server.shutdown",
  "world.loaded",
  "world.reset",
  "process.minute",
  // Identity
  "player.registered",
  "register.refused",
  "admin.refused",
  // Connection
  "hello.rejected",
  "join",
  "leave",
  "replaced",
  "dropped_slow",
  // Input
  "input.summary",
  "pos.rejected",
  "input.rate_limited",
  "input.rejected",
  // Consistency
  "desync",
  "resync",
  "hash.minute",
  "snapshot.requested",
  "snapshot.accepted",
  "snapshot.rejected",
  "snapshot.abandoned",
  // Housekeeping
  "tick_log.flush_failed",
  "identity.evicted",
  "world.cold_start",
  "world.build_changed",
  "world.log_repaired",
  "server.unhandled_rejection",
  // Later (M5/M6): reserved names only. Nothing emits these yet.
  "claim.death",
  "claim.kill",
  "achievement.awarded",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** A flat, JSON-safe field value. A bigint is logged as a hex string before it reaches a subscriber. */
export type FieldValue = string | number | boolean | null;
export type EventFields = Record<string, FieldValue | bigint | undefined>;

/** One logged event as the ring buffer and subscribers see it: bigints already converted. */
export interface LogEvent {
  t: string;
  lvl: EventLevel;
  ev: EventName;
  [field: string]: FieldValue | undefined;
}
