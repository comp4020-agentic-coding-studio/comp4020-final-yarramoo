import { ROLES, type Action, type Role } from "../engine/types.ts";

// Who is connected, where they are looking, and what gesture they just made.
// All of it is public to the whole crew and none of it is persisted. The rule
// the 3D world must not break: a gesture says THAT a seat acted, never WHAT it
// did, so `gestureKind` reads the action's type and nothing else (no step id,
// no poll id, no value), and every step, a fix step included, is "press".
//
// Everything here is in memory and bounded: a per-mission map exists only while
// someone is connected (presence) or for at most 10 minutes after the last
// connection (heads), and holds at most one entry per role.

const PRESENCE_DEBOUNCE_MS = 300;
const LOOK_MIN_INTERVAL_MS = 200; // at most 5 Hz per mission
const IDLE_DROP_MS = 10 * 60_000;

export type GestureKind =
  | "press" | "call_poll" | "report_go" | "report_nogo"
  | "hold" | "resume" | "scrub" | "start" | "terminate";

/** The coarse gesture for an accepted action, derived from its type (and, for a poll report, the public go/no-go). */
export function gestureKind(action: Action): GestureKind | null {
  switch (action.type) {
    case "step": return "press";
    case "poll_open": return "call_poll";
    case "poll_report": return action.report === "go" ? "report_go" : "report_nogo";
    case "hold": return "hold";
    case "resume": return "resume";
    case "scrub": return "scrub";
    case "start": return "start";
    case "terminate": return "terminate";
    default: return null;
  }
}

export type Head = [yaw: number, pitch: number];

export interface Sinks {
  /** Presence changed for this mission: publish a fresh lobby message. */
  presence(code: string): void;
  /** Publish these heads (only roles that changed) on the lobby topic. */
  looks(code: string, heads: Record<string, Head>): void;
}
let sinks: Sinks = { presence() {}, looks() {} };
export function setSinks(s: Sinks): void {
  sinks = s;
}

// -------------------------------------------------------------------- presence

const open = new Map<string, Map<string, number>>(); // code -> lowercase callsign -> open streams
const presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePresence(code: string): void {
  if (presenceTimers.has(code)) return;
  const t = setTimeout(() => {
    presenceTimers.delete(code);
    sinks.presence(code);
  }, PRESENCE_DEBOUNCE_MS);
  t.unref();
  presenceTimers.set(code, t);
}

/** An open stream for this crew member (null: an observer, who is not shown). Returns the close function. */
export function streamOpened(code: string, callsign: string | null): () => void {
  touchHeads(code);
  if (!callsign) return () => touchHeads(code);
  const key = callsign.toLowerCase();
  let m = open.get(code);
  if (!m) open.set(code, (m = new Map()));
  const before = m.get(key) ?? 0;
  m.set(key, before + 1);
  if (before === 0) schedulePresence(code);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const mm = open.get(code);
    if (!mm) return;
    const n = (mm.get(key) ?? 1) - 1;
    if (n <= 0) {
      mm.delete(key);
      if (mm.size === 0) open.delete(code);
      schedulePresence(code);
    } else mm.set(key, n);
    touchHeads(code);
  };
}

/** `{ role: true|false }`: is the crew member holding the seat connected to this mission? */
export function presentRoles(code: string, roles: readonly Role[], seats: Partial<Record<Role, string>>): Record<string, boolean> {
  const m = open.get(code);
  const out: Record<string, boolean> = {};
  for (const r of roles) {
    const holder = seats[r];
    out[r] = !!holder && (m?.has(holder.toLowerCase()) ?? false);
  }
  return out;
}

// ----------------------------------------------------------------------- heads

interface Heads {
  latest: Map<Role, Head>;
  dirty: Set<Role>;
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
  touched: number;
}
const heads = new Map<string, Heads>();

function headsOf(code: string): Heads {
  let h = heads.get(code);
  if (!h) heads.set(code, (h = { latest: new Map(), dirty: new Set(), lastSent: 0, timer: null, touched: Date.now() }));
  return h;
}

function touchHeads(code: string): void {
  const h = heads.get(code);
  if (h) h.touched = Date.now();
}

function flushHeads(code: string): void {
  const h = heads.get(code);
  if (!h) return;
  h.timer = null;
  if (h.dirty.size === 0) return;
  const out: Record<string, Head> = {};
  for (const r of h.dirty) {
    const v = h.latest.get(r);
    if (v) out[r] = v;
  }
  h.dirty.clear();
  h.lastSent = Date.now();
  sinks.looks(code, out);
}

/** Parse, wrap and clamp a client's head direction; null when either number is not finite. */
export function cleanHead(yaw: unknown, pitch: unknown): Head | null {
  const num = (v: unknown): number => (typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN);
  const y = num(yaw), p = num(pitch);
  if (!Number.isFinite(y) || !Number.isFinite(p)) return null;
  let w = Math.atan2(Math.sin(y), Math.cos(y)); // (-pi, pi]
  if (w <= -Math.PI) w = Math.PI;
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return [round(w), round(Math.max(-1.2, Math.min(1.2, p)))];
}

/** Remember a seat's latest head direction and publish it, coalesced to 5 Hz per mission. */
export function setHead(code: string, role: Role, head: Head): void {
  if (!ROLES.includes(role)) return;
  const h = headsOf(code);
  h.touched = Date.now();
  const prev = h.latest.get(role);
  if (prev && prev[0] === head[0] && prev[1] === head[1]) return;
  h.latest.set(role, head);
  h.dirty.add(role);
  if (h.timer) return;
  const wait = Math.max(0, h.lastSent + LOOK_MIN_INTERVAL_MS - Date.now());
  h.timer = setTimeout(() => flushHeads(code), wait);
  h.timer.unref();
}

/** Every seat's current head, for a newly connected stream. Empty when nobody has looked. */
export function currentHeads(code: string): Record<string, Head> {
  const out: Record<string, Head> = {};
  for (const [r, v] of heads.get(code)?.latest ?? []) out[r] = v;
  return out;
}

/** The mission is over: forget its heads. */
export function clearMission(code: string): void {
  const h = heads.get(code);
  if (h?.timer) clearTimeout(h.timer);
  heads.delete(code);
}

/** Drop heads of missions with nobody connected for 10 minutes. */
export function sweep(now = Date.now()): void {
  for (const [code, h] of heads) {
    if (!open.has(code) && now - h.touched > IDLE_DROP_MS) clearMission(code);
  }
}
setInterval(sweep, 60_000).unref();

/** Sizes of the in-memory maps, for tests and debugging. */
export function sizes(): { open: number; heads: number } {
  return { open: open.size, heads: heads.size };
}
