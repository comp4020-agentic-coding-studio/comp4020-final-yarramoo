import { isDeepStrictEqual } from "node:util";
import { hasSubscribers, publish } from "../bus.ts";
import { db, tx } from "../db/index.ts";
import { apply, tick } from "../engine/engine.ts";
import type { Action, ConsoleView, EngineEvent, Outcome, Phase, Role, Sequence, State } from "../engine/types.ts";
import { view } from "../engine/view.ts";
import { applyOutcome, claimForStart, publishAgency } from "./agency.ts";
import { rebuild, type LoggedAction } from "./replay.ts";
import { getSequence } from "./sequences.ts";
import { clearMission, currentHeads, gestureKind, presentRoles, setSinks, streamOpened } from "./presence.ts";
import { deleteStaleLobbies, getMission, publishHub, seatsOf, type MissionRow, type Seats } from "./store.ts";

// Live missions: in memory, ticked every 250 ms, persisted on every accepted
// action and event and at least every 5 s. The engine's clock is
// `Date.now() - clockOffsetMs`; downtime is added to the offset on boot so a
// restart pauses the countdown.

const TICK_MS = 250;
const PERSIST_EVERY_MS = 5_000;
const ABANDON_AFTER_MS = Number(process.env.ABANDON_AFTER_MS ?? 10 * 60_000); // env override is for testing

interface Room {
  id: number;
  code: string;
  seq: Sequence;
  seed: number;
  state: State;
  clockOffsetMs: number;
  seats: Seats;
  nextActionSeq: number;
  nextEventSeq: number;
  lastPersistAt: number;
  lastConsoleAt: number;
}

const live = new Map<string, Room>();
const streamCounts = new Map<string, number>();

export const roleTopic = (code: string, role: Role): string => `mission:${code}:${role}`;
export const lobbyTopic = (code: string): string => `mission:${code}:lobby`;

// ------------------------------------------------------------------- messages

export type LobbyMessage = {
  type: "lobby";
  serverNow: number;
  phase: Phase;
  tMs: number;
  seats: Record<string, string | null>;
  /** Is the crew member holding each seat connected? Public: it says who is at the pad, nothing about their console. */
  present: Record<string, boolean>;
  outcome: Outcome | null;
};

function lobbyMessage(code: string, seq: Sequence, state: State, seats: Seats, serverNow: number): LobbyMessage {
  const out: Record<string, string | null> = {};
  for (const r of seq.roles) out[r] = seats[r] ?? null;
  return { type: "lobby", serverNow, phase: state.phase, tMs: state.tMs, seats: out, present: presentRoles(code, seq.roles, seats), outcome: state.outcome };
}

function publishState(code: string, seq: Sequence, state: State, seats: Seats): void {
  const serverNow = Date.now();
  for (const role of seq.roles) {
    const topic = roleTopic(code, role);
    if (hasSubscribers(topic)) publish(topic, { type: "view", serverNow, role, view: view(seq, state, role) });
  }
  if (hasSubscribers(lobbyTopic(code))) publish(lobbyTopic(code), lobbyMessage(code, seq, state, seats, serverNow));
}

/** Seat change in a lobby: tell everyone the new seats, then tell them to reconnect. */
export function publishSeatChange(code: string): void {
  const m = getMission(code);
  if (!m) return;
  const seq = getSequence(m.sequence_id);
  const state = JSON.parse(m.state_json) as State;
  publish(lobbyTopic(code), lobbyMessage(code, seq, state, seatsOf(m.id), Date.now()));
  publish(lobbyTopic(code), { type: "reseat" });
}

/** A fresh lobby message for a mission, live or not (presence changed). */
function publishLobby(code: string): void {
  if (!hasSubscribers(lobbyTopic(code))) return;
  const room = live.get(code);
  if (room) return void publish(lobbyTopic(code), lobbyMessage(code, room.seq, room.state, room.seats, Date.now()));
  const m = getMission(code);
  if (!m) return;
  publish(lobbyTopic(code), lobbyMessage(code, getSequence(m.sequence_id), JSON.parse(m.state_json) as State, seatsOf(m.id), Date.now()));
}

setSinks({
  presence: publishLobby,
  looks: (code, heads) => publish(lobbyTopic(code), { type: "look", heads }),
});

/** After an ACCEPTED action: tell everyone THAT this seat acted, not what it did (see presence.ts). */
export function publishGesture(code: string, action: Action): void {
  const kind = gestureKind(action);
  if (kind) publish(lobbyTopic(code), { type: "gesture", role: action.role, kind, at: Date.now() });
}

/** What a newly connected stream gets first: the lobby message and the views for the roles it holds. */
export function snapshot(
  code: string,
  roles: Role[],
): { lobby: LobbyMessage; views: Record<string, ConsoleView>; heads: Record<string, [number, number]> } | null {
  const room = live.get(code);
  let seq: Sequence, state: State, seats: Seats;
  if (room) {
    tickRoom(room);
    ({ seq, state, seats } = room);
  } else {
    const m = getMission(code);
    if (!m) return null;
    seq = getSequence(m.sequence_id);
    state = JSON.parse(m.state_json) as State;
    seats = seatsOf(m.id);
  }
  const views: Record<string, ConsoleView> = {};
  for (const r of roles) if (seq.roles.includes(r)) views[r] = view(seq, state, r);
  return { lobby: lobbyMessage(code, seq, state, seats, Date.now()), views, heads: currentHeads(code) };
}

/** Count an open stream against a mission (and mark its crew member present); returns the disconnect function. */
export function attach(code: string, callsign: string | null = null): () => void {
  streamCounts.set(code, (streamCounts.get(code) ?? 0) + 1);
  const room = live.get(code);
  if (room) room.lastConsoleAt = Date.now();
  const closePresence = streamOpened(code, callsign);
  return () => {
    closePresence();
    const n = (streamCounts.get(code) ?? 1) - 1;
    if (n <= 0) streamCounts.delete(code);
    else streamCounts.set(code, n);
    const r = live.get(code);
    if (r) r.lastConsoleAt = Date.now();
  };
}

// ---------------------------------------------------------------- persistence

const insertAction = () =>
  db.prepare("INSERT INTO mission_actions (mission_id, seq, now_ms, crew_id, action_json) VALUES (?, ?, ?, ?, ?)");
const insertEvent = () =>
  db.prepare("INSERT INTO mission_events (mission_id, seq, at_t, kind, role, data_json) VALUES (?, ?, ?, ?, ?, ?)");

/** Write the new state, its events and (if given) the accepted action in one transaction; then adopt it. */
function commit(
  room: Room,
  state: State,
  events: EngineEvent[],
  logged?: { nowMs: number; action: Action; crewId: number | null },
): void {
  const now = Date.now();
  let actionSeq = room.nextActionSeq;
  let eventSeq = room.nextEventSeq;
  let agencyChanged = false;
  tx(() => {
    if (logged) {
      insertAction().run(room.id, actionSeq++, logged.nowMs, logged.crewId, JSON.stringify(logged.action));
    }
    const ie = insertEvent();
    for (const e of events) {
      ie.run(room.id, eventSeq++, e.atT, e.kind, e.role ?? null, e.data ? JSON.stringify(e.data) : null);
    }
    if (state.phase === "done") {
      const r = db.prepare(
        "UPDATE missions SET status = 'done', state_json = ?, last_seen_ms = ?, outcome_json = ?, ended_at = ? WHERE id = ? AND status != 'done'",
      ).run(JSON.stringify(state), now, JSON.stringify(state.outcome), now, room.id);
      // AGENCY HOOK: the outcome's budget, reputation, rocket and pad consequences
      // are written in THIS transaction, so a mission is never done without them
      // (and never charged twice: the status guard above makes this run once).
      if (Number(r.changes) > 0) {
        applyOutcome(room.id, state, now);
        agencyChanged = true;
      }
    } else {
      db.prepare("UPDATE missions SET state_json = ?, last_seen_ms = ? WHERE id = ?").run(
        JSON.stringify(state),
        now,
        room.id,
      );
    }
  });
  room.nextActionSeq = actionSeq;
  room.nextEventSeq = eventSeq;
  room.state = state;
  room.lastPersistAt = now;
  if (state.phase === "done") {
    live.delete(room.code);
    clearMission(room.code);
  }
  if (agencyChanged) publishAgency();
  if (state.phase === "done") publishHub();
}

// ---------------------------------------------------------------------- clock

/** The engine's nowMs for this room; never goes backwards even if the wall clock does. */
function nowOf(room: Room): number {
  return Math.max(Date.now() - room.clockOffsetMs, room.state.lastNowMs ?? 0);
}

// -------------------------------------------------------------------- actions

export type ActResult = { ok: true } | { ok: false; error: string };

/** Apply an action to a live room: log it if accepted, persist whatever ticking produced, push. */
function applyTo(room: Room, action: Action, crewId: number | null): ActResult {
  const nowMs = nowOf(room);
  const r = apply(room.seq, room.state, action, nowMs);
  if (r.ok) {
    commit(room, r.state, r.events, { nowMs, action, crewId });
  } else if (r.events.length > 0) {
    commit(room, r.state, r.events); // the tick before the rejection did something
  } else {
    room.state = r.state;
  }
  publishState(room.code, room.seq, room.state, room.seats);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export function act(code: string, crewId: number, action: Action): ActResult {
  const room = live.get(code);
  if (!room) {
    const m = getMission(code);
    if (!m) return { ok: false, error: "no such mission" };
    return { ok: false, error: m.status === "done" ? "the mission is over" : "the countdown has not started" };
  }
  return applyTo(room, action, crewId);
}

/** Lobby to live. Every role in the sequence must be seated; the flight seat sends it. */
export function startMission(m: MissionRow, crewId: number): ActResult {
  if (m.status !== "lobby") return { ok: false, error: "the countdown has already started" };
  const seq = getSequence(m.sequence_id);
  const seats = seatsOf(m.id);
  const open = seq.roles.filter((r) => !seats[r]);
  if (open.length > 0) return { ok: false, error: `every seat must be filled before the count starts; open: ${open.join(", ")}` };

  // Agency gate: the rocket must still be ready and the pad usable. The engine is not called if not.
  const blocked = claimForStart(m);
  if (blocked) return { ok: false, error: blocked };

  const state0 = JSON.parse(m.state_json) as State;
  const offset = Date.now(); // nowMs 0 at the start
  const action: Action = { role: "flight", type: "start" };
  const r = apply(seq, state0, action, 0);
  if (!r.ok) return { ok: false, error: r.error };

  const now = Date.now();
  tx(() => {
    db.prepare(
      "UPDATE missions SET status = 'live', state_json = ?, clock_offset_ms = ?, last_seen_ms = ?, started_at = ? WHERE id = ? AND status = 'lobby'",
    ).run(JSON.stringify(r.state), offset, now, now, m.id);
    insertAction().run(m.id, 1, 0, crewId, JSON.stringify(action));
    const ie = insertEvent();
    r.events.forEach((e, i) => ie.run(m.id, i + 1, e.atT, e.kind, e.role ?? null, e.data ? JSON.stringify(e.data) : null));
  });
  const room: Room = {
    id: m.id,
    code: m.code,
    seq,
    seed: m.seed,
    state: r.state,
    clockOffsetMs: offset,
    seats,
    nextActionSeq: 2,
    nextEventSeq: r.events.length + 1,
    lastPersistAt: now,
    lastConsoleAt: now,
  };
  live.set(m.code, room);
  publishHub();
  publishState(m.code, seq, room.state, seats);
  return { ok: true };
}

// ----------------------------------------------------------------------- tick

/** Advance a room to now. Persists when something happened (or every 5 s); pushes on events. */
function tickRoom(room: Room): boolean {
  const r = tick(room.seq, room.state, nowOf(room));
  if (r.events.length > 0) {
    commit(room, r.state, r.events);
    publishState(room.code, room.seq, room.state, room.seats);
    return true;
  }
  room.state = r.state;
  if (Date.now() - room.lastPersistAt >= PERSIST_EVERY_MS) commit(room, r.state, []);
  return false;
}

let beat = 0;
function loopOnce(): void {
  beat++;
  const now = Date.now();
  for (const room of [...live.values()]) {
    try {
      const pushed = tickRoom(room);
      if (!live.has(room.code)) continue; // finished this tick
      if (!pushed && beat % 4 === 0) publishState(room.code, room.seq, room.state, room.seats);
      if ((streamCounts.get(room.code) ?? 0) > 0) room.lastConsoleAt = now;
      else if (now - room.lastConsoleAt > ABANDON_AFTER_MS) {
        console.log(`mission ${room.code}: crew lost contact, scrubbing`);
        applyTo(room, { role: "flight", type: "scrub", reason: "Crew lost contact" }, null);
      }
    } catch (e) {
      console.error(`tick failed for ${room.code}`, e);
    }
  }
  if (beat % 240 === 0) {
    const n = deleteStaleLobbies(now);
    if (n > 0) console.log(`deleted ${n} stale lobbies`);
  }
}

/** Load live missions from the database, pausing their clocks for the downtime. Then start ticking. */
export function startRooms(): void {
  const now = Date.now();
  deleteStaleLobbies(now);
  const rows = db.prepare("SELECT * FROM missions WHERE status = 'live'").all() as unknown as MissionRow[];
  for (const m of rows) {
    const seq = getSequence(m.sequence_id);
    const state = JSON.parse(m.state_json) as State;
    const downtime = Math.max(0, now - m.last_seen_ms);
    const offset = m.clock_offset_ms + downtime;
    db.prepare("UPDATE missions SET clock_offset_ms = ?, last_seen_ms = ? WHERE id = ?").run(offset, now, m.id);

    const actions = (
      db.prepare("SELECT now_ms, action_json FROM mission_actions WHERE mission_id = ? ORDER BY seq").all(m.id) as unknown as {
        now_ms: number;
        action_json: string;
      }[]
    ).map((a): LoggedAction => ({ nowMs: a.now_ms, action: JSON.parse(a.action_json) as Action }));
    const rebuilt = rebuild(seq, m.seed, actions, state.lastNowMs ?? 0);
    if (!isDeepStrictEqual(rebuilt, state)) {
      console.warn(`mission ${m.code}: replaying the action log does not reproduce the saved state; using the saved state`);
    }
    const next = (table: string): number =>
      ((db.prepare(`SELECT MAX(seq) AS s FROM ${table} WHERE mission_id = ?`).get(m.id) as { s: number | null }).s ?? 0) + 1;
    live.set(m.code, {
      id: m.id,
      code: m.code,
      seq,
      seed: m.seed,
      state,
      clockOffsetMs: offset,
      seats: seatsOf(m.id),
      nextActionSeq: next("mission_actions"),
      nextEventSeq: next("mission_events"),
      lastPersistAt: now,
      lastConsoleAt: now,
    });
    console.log(`mission ${m.code}: resumed at tMs ${state.tMs}, paused ${downtime} ms`);
  }
  setInterval(loopOnce, TICK_MS).unref();
}

/** Write every live mission's current state (graceful shutdown). */
export function flushRooms(): void {
  for (const room of [...live.values()]) {
    try {
      tickRoom(room);
      if (live.has(room.code)) commit(room, room.state, []);
    } catch (e) {
      console.error(`flush failed for ${room.code}`, e);
    }
  }
}
