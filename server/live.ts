/** GET /api/live: a ring of the newest public deaths plus a 2 s response cache. Pure, so tests inject the clock. */
export interface LiveDeath {
  victim: string;
  killer: string | null;
  self: boolean;
  cause: number;
  bag: boolean;
  mode: string;
  at: number;
}

/** D-237: `gameRooms` is the Survival/Deathmatch rooms loaded now and the cap, so the menu can say when it is full. */
export interface LiveCounts {
  players: number;
  rooms: number;
  gameRooms: { live: number; max: number };
}

export const LIVE_MAX_DEATHS = 20;
export const LIVE_CACHE_MS = 2000;

export interface LiveFeed {
  recordDeath(d: LiveDeath): void;
  /** The response JSON; `count` runs only when the cache is stale (once per 2 s, or after a death). */
  json(count: () => LiveCounts): string;
}

export function createLiveFeed(opts: { now?: () => number } = {}): LiveFeed {
  const now = opts.now ?? Date.now;
  const ring: LiveDeath[] = []; // newest first
  let cached: string | null = null;
  let cachedAt = 0;
  return {
    recordDeath(d) {
      ring.unshift(d);
      if (ring.length > LIVE_MAX_DEATHS) ring.length = LIVE_MAX_DEATHS;
      cached = null;
    },
    json(count) {
      const t = now();
      if (cached === null || t - cachedAt >= LIVE_CACHE_MS || t < cachedAt) {
        const { players, rooms, gameRooms } = count();
        cached = JSON.stringify({ players, rooms, gameRooms, deaths: ring });
        cachedAt = t;
      }
      return cached;
    },
  };
}
