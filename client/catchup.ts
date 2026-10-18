// Pure helpers behind the catch-up progress card: a moving-average replay rate and the remaining-time text.
// Display only; nothing here reaches the sim.

/** Seconds of history the rate is averaged over. */
export const RATE_WINDOW_MS = 5000;

export interface Sample {
  ms: number;
  tick: number;
}

/** Ticks per second over the samples inside the window ending at the newest one; null with under two samples or no time/progress. */
export function replayRate(samples: readonly Sample[], windowMs = RATE_WINDOW_MS): number | null {
  if (samples.length < 2) return null;
  const newest = samples[samples.length - 1];
  let oldest = newest;
  for (let i = samples.length - 2; i >= 0 && newest.ms - samples[i].ms <= windowMs; i--) oldest = samples[i];
  const dt = newest.ms - oldest.ms;
  const dticks = newest.tick - oldest.tick;
  if (dt <= 0 || dticks <= 0) return null;
  return (dticks * 1000) / dt;
}

/** Remaining time in words, rounded coarsely so it does not pretend to precision. Null rate: unknown. */
export function etaText(remainingTicks: number, ticksPerSec: number | null): string {
  if (remainingTicks <= 0) return "almost there";
  if (ticksPerSec === null || !(ticksPerSec > 0)) return "estimating…";
  const s = remainingTicks / ticksPerSec;
  if (s < 5) return "a few seconds";
  if (s < 50) return `about ${Math.round(s / 5) * 5} seconds`;
  if (s < 90) return "about a minute";
  const min = Math.round(s / 60);
  if (min < 60) return `about ${min} minutes`;
  return "over an hour";
}
