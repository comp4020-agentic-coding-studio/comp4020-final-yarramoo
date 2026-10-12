import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isSecure } from "./auth.ts";
import { db } from "./db/index.ts";

export interface Crew {
  id: number;
  callsign: string;
}

const CALLSIGN = /^[A-Za-z0-9_-]{2,16}$/;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export type CreateResult = { ok: true; crew: Crew; token: string } | { ok: false; error: string; status: 409 | 422 };

/** Make a crew member. The raw token is returned once, for the cookie; only its hash is stored. */
export function createCrew(callsign: string): CreateResult {
  if (!CALLSIGN.test(callsign)) {
    return { ok: false, status: 422, error: "A callsign is 2 to 16 characters: letters, digits, underscore or hyphen." };
  }
  const token = randomBytes(32).toString("hex");
  try {
    const r = db
      .prepare("INSERT INTO crew (callsign, token_hash, created_at) VALUES (?, ?, ?)")
      .run(callsign, sha256(token), Date.now());
    return { ok: true, crew: { id: Number(r.lastInsertRowid), callsign }, token };
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) {
      return { ok: false, status: 409, error: `The callsign ${callsign} is already taken. Pick another.` };
    }
    throw e;
  }
}

export function setCrewCookie(c: Context, token: string): void {
  setCookie(c, "crew", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecure(c),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** The crew member for this request's cookie, or null. Cached per request. */
export function currentCrew(c: Context): Crew | null {
  const cached = c.get("crewMember") as Crew | null | undefined;
  if (cached !== undefined) return cached;
  let found: Crew | null = null;
  const token = getCookie(c, "crew");
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    const row = db.prepare("SELECT id, callsign FROM crew WHERE token_hash = ?").get(sha256(token)) as
      | { id: number; callsign: string }
      | undefined;
    if (row) found = { id: row.id, callsign: row.callsign };
    else deleteCookie(c, "crew", { path: "/" });
  }
  c.set("crewMember", found);
  return found;
}
