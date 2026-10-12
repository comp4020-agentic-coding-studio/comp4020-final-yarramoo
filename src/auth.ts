import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const isSecure = (c: Context) => c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");

/**
 * CSRF by double-submit: a random httpOnly `csrf` cookie, set on first use,
 * whose value must equal the hidden `_csrf` form field. No users or sessions.
 */
export function csrfToken(c: Context): string {
  let t = getCookie(c, "csrf");
  if (!t || !/^[0-9a-f]{32}$/.test(t)) {
    t = randomBytes(16).toString("hex");
    setCookie(c, "csrf", t, { httpOnly: true, sameSite: "Lax", secure: isSecure(c), path: "/" });
    c.set("csrfNew", t);
  }
  return (c.get("csrfNew") as string | undefined) ?? t;
}

export function csrfOk(c: Context, submitted: unknown): boolean {
  if (typeof submitted !== "string" || !submitted) return false;
  const want = getCookie(c, "csrf");
  if (!want || want.length !== submitted.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(submitted));
}

/** Middleware: every POST must carry a valid `_csrf` field (urlencoded or multipart). */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "POST") {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    if (!csrfOk(c, body["_csrf"])) return c.text("Invalid or missing CSRF token", 403);
  }
  await next();
};

/** Only same-origin absolute paths. */
export function safeNext(n: string | undefined | null): string {
  return n && /^\/(?![/\\])/.test(n) ? n : "/";
}
