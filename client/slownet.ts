// The "your connection is slow" decision (brief SLOWNET, 8 Nov). Pure: samples in, what to show out. Display only;
// nothing here reaches the sim or the server. Thresholds are from tests/soak/slow-net.ts runs, docs/research/slow-net-report.md.
export type SlowReason = "latency" | "stall";

/** One reading, at the worker's stats cadence (every 500 ms): net state, the PING round trip, and the steps/buffer. */
export interface SlowSample {
  ms: number;
  state: string;
  /** Last PING round trip, ms; 0 = no reading yet (unknown). Refreshed every 2 s, so a reading persists for 2 s. */
  pingMs: number;
  /** Sim steps per second over the last stats window. */
  stepsPerSec: number;
  /** Ticks received and not yet applied. */
  buffered: number;
}

export interface SlowState {
  shown: SlowReason | null;
  latOn: boolean;
  stallOn: boolean;
  latBadSince: number | null;
  latGoodSince: number | null;
  stallBadSince: number | null;
  stallGoodSince: number | null;
}

export const SLOW_IDLE: SlowState = { shown: null, latOn: false, stallOn: false, latBadSince: null, latGoodSince: null, stallBadSince: null, stallGoodSince: null };

/** A round trip at or above this is "slow". Clean measured at most 169 ms (350 under heavy load); 800 ms RTT read 790-970. */
export const LAT_ON_MS = 600;
/** ...for this long: two PING readings in a row, so one stale spike (a reading after a hiccup) never shows. */
export const LAT_ON_HOLD_MS = 4000;
/** Hidden again only under this... */
export const LAT_OFF_MS = 250;
/** ...for this long (three readings): a 150-400 ms link with 3-10% loss swings between 190 and 700 ms. */
export const LAT_OFF_HOLD_MS = 6000;
/** Live, nothing stepped and nothing queued for this long: no ticks are arriving. The world is frozen for this player. */
export const STALL_ON_HOLD_MS = 1500;
/** Ticks flowing again for this long hides the stall. */
export const STALL_OFF_HOLD_MS = 1000;

const since = (cond: boolean, prev: number | null, ms: number): number | null => (cond ? (prev ?? ms) : null);

export function nextSlow(prev: SlowState, s: SlowSample): SlowState {
  // Catching up, reconnecting and rejected have their own card and note; start afresh when live again.
  if (s.state !== "live") return SLOW_IDLE;
  const known = s.pingMs > 0;
  const latBadSince = since(known && s.pingMs >= LAT_ON_MS, prev.latBadSince, s.ms);
  const latGoodSince = since(known && s.pingMs < LAT_OFF_MS, prev.latGoodSince, s.ms);
  // An unknown reading neither starts nor ends a run: keep what there was.
  const lb = known ? latBadSince : prev.latBadSince;
  const lg = known ? latGoodSince : prev.latGoodSince;
  let latOn = prev.latOn;
  if (!latOn && lb !== null && s.ms - lb >= LAT_ON_HOLD_MS) latOn = true;
  else if (latOn && lg !== null && s.ms - lg >= LAT_OFF_HOLD_MS) latOn = false;

  const starved = s.stepsPerSec < 1 && s.buffered <= 0;
  const stallBadSince = since(starved, prev.stallBadSince, s.ms);
  const stallGoodSince = since(!starved, prev.stallGoodSince, s.ms);
  let stallOn = prev.stallOn;
  if (!stallOn && stallBadSince !== null && s.ms - stallBadSince >= STALL_ON_HOLD_MS) stallOn = true;
  else if (stallOn && stallGoodSince !== null && s.ms - stallGoodSince >= STALL_OFF_HOLD_MS) stallOn = false;

  return { shown: stallOn ? "stall" : latOn ? "latency" : null, latOn, stallOn, latBadSince: lb, latGoodSince: lg, stallBadSince, stallGoodSince };
}

/** The notice's words. Plain: what is wrong and what it means for the game. */
export function slowText(reason: SlowReason, pingMs: number): { title: string; detail: string } {
  if (reason === "stall") return { title: "Connection stalled", detail: "No updates from the server: reconnecting if it does not come back" };
  const rt = pingMs >= 1000 ? `${(Math.round(pingMs / 100) / 10).toFixed(1)} s` : `${Math.round(pingMs / 10) * 10} ms`;
  return { title: "Slow connection", detail: `${rt} round trip: others see your moves late` };
}
