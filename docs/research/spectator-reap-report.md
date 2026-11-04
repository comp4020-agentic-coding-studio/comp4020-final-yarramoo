# Spectator reap (sec review S2): a join deadline for members that never go live

## What changed
- `server/world.ts`: `JOIN_DEADLINE_MS = 120_000` (= `CATCHUP_HOLD_MAX_MS`), `JOIN_HARD_MULTIPLE = 4`, `WorldOptions.joinDeadlineMs`
  (and `ServerOptions.joinDeadlineMs` in `server/main.ts`), and `World.reapNeverLive`, called from `tick()` before the
  paused-clock early return. It closes a not-live member through the normal path (`dropped` -> `leave`), close code
  `CLOSE_SILENT`, logged via `elog.limited` as `leave` with `reason: "never_live"` (an existing event name).
- `tests/net/join-deadline.test.ts`: silent spectator closed; replaying+pinging client kept; live member kept.

## The rule
A not-live member is closed when EITHER `now - lastHeard >= JOIN_DEADLINE_MS` (sent no frame at all) OR
`now - catchupSince >= 4 x JOIN_DEADLINE_MS` (8 min since it began catching up, even if it keeps pinging).
Catch-up reports progress only as frames: the worker pings every 2 s from open and sends LIVE/HASH at the replay
target; there is no progress frame. So `lastHeard` (advanced by any frame, via `heard()`) is the progress signal, and a
slow replay of a big log that keeps pinging is not closed by rule 1. Rule 2 exists because a ping-only socket would
otherwise still hold a slot forever (attacker adds a ping timer). `catchupSince` resets on resync, so a member
resyncing repeatedly is already bounded by the resync budget.

## Red first
With the `reapNeverLive` call disabled, "a spectator that sends HELLO and nothing else is closed" failed:
`timed out waiting for never-live socket closed`. The other two tests passed (they assert non-closure).

## Architectural decisions for review
- **Deadline value 120 s.** Chosen equal to the hold max. Alternative: shorter (30 s) for silent sockets only, since
  a real client pings within 2 s. Cost of 120 s: an attacker's slots live 2 min per cycle, and rejoin costs them a HELLO
  each, so 36 slots refilled needs ~0.3 HELLO/s; the per-IP cap and S2's other fixes (separate spectator cap) still matter.
  Cheap to tighten: change one constant, but a slow real client must still not be cut before it first pings.
- **Rule 1 uses `lastHeard`, not join time.** Keeps a slow-but-talking replay alive. Costs: a ping-only attacker survives
  until rule 2 (8 min). The 4x multiple is arbitrary; a replay needing more than 8 min would be closed and resync.
- **Runs before the `isPaused` return and is skipped when the tick loop stalled** (same guard as `reapSilent`), because a
  world held for a replaying member is exactly where silent sockets sit. Not done: the other S2 parts (separate cap for
  anonymous spectators, refusing to load rooms for spectator HELLO).
- **Reused `leave` event and `CLOSE_SILENT` (4002)** rather than a new event/close code: the dashboard and client already
  handle both. A client cannot yet tell "never live" from "silent".
