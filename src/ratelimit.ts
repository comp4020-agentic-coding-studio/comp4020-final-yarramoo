import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

// A tiny in-memory fixed-window limiter. It is per process, which is right for
// the single Fly machine this app runs on, and forgets everything on restart.
// A fixed window can let through up to twice the limit across a boundary; that
// is fine for stopping scripts and floods, which is all this is for.

/** Multiplies every limit. 1 in production; raise it (never lower it) to run the spec twice inside a minute. */
const SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE ?? 1) || 1);

export interface Limiter {
  /** Count one hit for `key`. `retryAfterMs` is 0 when allowed. */
  hit(key: string, now?: number): { ok: boolean; retryAfterMs: number };
  /** Would a hit for `key` be refused right now? Counts nothing. */
  blocked(key: string, now?: number): { blocked: boolean; retryAfterMs: number };
  /** Number of keys currently tracked (for tests). */
  size(): number;
}

export function createLimiter(limit: number, windowMs: number): Limiter {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = 0;
  return {
    hit(key, now = Date.now()) {
      // Drop expired windows now and then so a stream of one-off keys cannot grow the map for ever.
      if (now - lastSweep > windowMs) {
        lastSweep = now;
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) windows.set(key, (w = { start: now, count: 0 }));
      if (w.count >= limit) return { ok: false, retryAfterMs: w.start + windowMs - now };
      w.count++;
      return { ok: true, retryAfterMs: 0 };
    },
    blocked(key, now = Date.now()) {
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs || w.count < limit) return { blocked: false, retryAfterMs: 0 };
      return { blocked: true, retryAfterMs: w.start + windowMs - now };
    },
    size: () => windows.size,
  };
}

/** The caller's address: Fly's header, else the first X-Forwarded-For entry, else the socket. */
export function clientIp(c: Context): string {
  const fly = c.req.header("fly-client-ip")?.trim();
  if (fly) return fly;
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** What to count against; a missing key means "do not limit this one". */
  key: (c: Context) => string | null;
  /** The 429 response. */
  reject: (c: Context, retryAfterSec: number) => Response | Promise<Response>;
  /** Only count requests for which this is true (default: all). */
  when?: (c: Context) => boolean;
}

/** Middleware form, for routes that count every request. */
export function rateLimit(o: RateLimitOptions): MiddlewareHandler {
  const lim = createLimiter(o.limit * SCALE, o.windowMs);
  return async (c, next) => {
    const key = o.key(c);
    if (key !== null && (o.when?.(c) ?? true)) {
      const r = lim.hit(key);
      if (!r.ok) {
        const secs = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
        c.header("Retry-After", String(secs));
        return o.reject(c, secs);
      }
    }
    await next();
  };
}

/** A limiter the handler consults itself, for counting only some outcomes (a successful sign-up). */
export function scaled(limit: number, windowMs: number): Limiter {
  return createLimiter(limit * SCALE, windowMs);
}
