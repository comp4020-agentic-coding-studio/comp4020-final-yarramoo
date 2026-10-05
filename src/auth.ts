import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "./db/index.ts";

export type User = { id: number; handle: string; display_name: string | null; bio: string | null; postcode: string | null };
export type Session = { token: string; user_id: number | null; csrf: string };

const DAY = 86_400_000;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [s, h] = stored.split(":");
  if (!s || !h) return false;
  const want = Buffer.from(h, "hex");
  const got = scryptSync(pw, Buffer.from(s, "hex"), want.length);
  return timingSafeEqual(want, got);
}

const isSecure = (c: Context) => c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");

/** Create a session (also used anonymously: user_id is null-able in code, but the table requires a user, so anonymous CSRF uses a signed-out cookie "anon"). */
export function startSession(c: Context, userId: number): void {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, csrf, expires_at) VALUES (?,?,?,?)").run(
    token, userId, csrf, new Date(Date.now() + 30 * DAY).toISOString(),
  );
  setCookie(c, "sid", token, { httpOnly: true, sameSite: "Lax", secure: isSecure(c), path: "/", maxAge: 30 * 86400 });
}

export function endSession(c: Context): void {
  const t = getCookie(c, "sid");
  if (t) db.prepare("DELETE FROM sessions WHERE token = ?").run(t);
  deleteCookie(c, "sid", { path: "/" });
}

/** Signed-in session for this request, or null. */
export function currentSession(c: Context): { token: string; user_id: number; csrf: string } | null {
  const t = getCookie(c, "sid");
  if (!t || !/^[0-9a-f]{64}$/.test(t)) return null;
  const row = db.prepare("SELECT token, user_id, csrf, expires_at FROM sessions WHERE token = ?").get(t) as
    | { token: string; user_id: number; csrf: string; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(t);
    return null;
  }
  return row;
}

export function currentUser(c: Context): User | null {
  const s = currentSession(c);
  if (!s) return null;
  return (db.prepare("SELECT id, handle, display_name, bio, postcode FROM users WHERE id = ?").get(s.user_id) as User | undefined) ?? null;
}

/**
 * CSRF. Signed-in: per-session token. Signed-out forms (login/signup) use a
 * double-submit token: a `csrf` cookie whose value must equal the hidden field.
 */
export function csrfToken(c: Context): string {
  const s = currentSession(c);
  if (s) return s.csrf;
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
  const s = currentSession(c);
  const want = s ? s.csrf : getCookie(c, "csrf");
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

/** Middleware: redirect anonymous users to /login?next=<current path>. */
export const requireUser: MiddlewareHandler = async (c, next) => {
  if (!currentUser(c)) {
    const u = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  }
  await next();
};

/** Only same-origin absolute paths. */
export function safeNext(n: string | undefined | null): string {
  return n && /^\/(?![/\\])/.test(n) ? n : "/";
}

setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString()), 3_600_000).unref();
