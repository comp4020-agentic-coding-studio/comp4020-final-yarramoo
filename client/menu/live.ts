// Menu helpers: relative time, a visibility-aware poller, and the /api/live client (players live + death log).
import { formatDeath } from "../toasts.ts";

export interface LiveDeath {
  victim: string;
  killer: string | null;
  self: boolean;
  cause: number;
  bag: boolean;
  mode: string;
  at: number;
}
export interface Live {
  players: number;
  rooms: number;
  deaths: LiveDeath[];
}

/** "12s", "4m", "3h", "2d". Negative (clock skew) reads as "0s". */
export function relTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The same sentence the in-game death feed uses (plain names only). */
export function deathLine(d: LiveDeath): string {
  const killer = d.killer === null ? 0 : d.self ? 1 : 2;
  const names: Record<number, string> = { 1: d.victim, 2: d.killer ?? "" };
  return formatDeath({ victim: 1, killer, cause: d.cause, bagDropped: d.bag }, (id) => names[id]);
}

/**
 * Run `fn` now and every `ms`, but not while the tab is hidden; on becoming visible run it at once.
 * Returns a stop function. A slow `fn` never overlaps itself.
 */
export function startPoll(fn: () => Promise<void> | void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch {
      // keep the last-known state on screen
    } finally {
      busy = false;
    }
  };
  const start = () => {
    if (timer !== null) return;
    void run();
    timer = setInterval(() => void run(), ms);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVis);
  if (!document.hidden) start();
  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVis);
  };
}

/** GET /api/live; null on any failure (404 before the server has it, offline), so the UI hides the stat. */
export async function fetchLive(): Promise<Live | null> {
  try {
    const r = await fetch("/api/live");
    if (!r.ok) return null;
    const j = (await r.json()) as Live;
    if (typeof j.players !== "number" || !Array.isArray(j.deaths)) return null;
    return j;
  } catch {
    return null;
  }
}
