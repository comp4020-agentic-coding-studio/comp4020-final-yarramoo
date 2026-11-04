# Brief N1: a room dies when nobody has been in it for a while

**The user's rule (4 Nov):** "If there are no active players then the room should die." With a grace period, so a
reload, a phone lock or a redeploy doesn't kill a live room, and a just-shared link survives until the friend arrives:

- a room that **someone has joined** dies after **2 minutes** with no members (`ROOM_UNLOAD_MS` today; it only frees
  memory now);
- a room that **nobody has ever joined** dies **10 minutes** after creation;
- **at startup**, delete only rooms already past their grace period before the restart. A server that just booted
  has no members anywhere, so "empty now" is not the test: use the stored time (`rooms.last_active`, kept current
  while a room is occupied, and `created_at`).

"Dies" means: the room's row, its snapshots and its tick log are deleted, so it leaves every list and its code stops
resolving (`GET /api/rooms/:code` gives 404; the client already says "No room has that code."). Player stats and
achievements stay. The two fixed worlds (`SANDBOX_ID`, `GAME_ID`) never die. **Spectators count as people in the
room** (members of any kind keep it alive) — a room being watched isn't abandoned.

**Worker:** one Sonnet worker on `multa` in `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`. No subagents,
about 70 tool calls. Rules: `CLAUDE.md`; commits only on a green gate chained with `&&` (the exit code must be the
test's: never `;`, never piped through `grep` or `tail`); red-first tests; `rm` only on literal absolute paths; **no
pushing**; stage explicit paths only (other workers are active in `/tmp/wt-*` and may leave files in this repo's
`docs/`); no `console.*` in `server/`; new log names in `shared/events.ts`. Use server ports 8110-8119 for anything
you run by hand. Kill what you start, by PID.

**Files you may touch:** `server/main.ts`, `server/rooms.ts`, `server/db.ts` (append-only migrations, if you need an
index or column), `server/world.ts` only if needed, `shared/events.ts`, `tests/net/**`, `docs/DECISIONS.md`. Not
`client/` (other workers own it tonight), not `sim/`.

## What to build

1. **`last_active` stays honest.** Find where it's written today. While a room has members it must be refreshed at
   least once a minute (cheap: on the existing minute timer, or on join and leave plus a periodic touch). A row's
   `last_active` is then "the last moment anyone was in it" to within a minute.
2. **Delete on the unload timer.** When `scheduleUnload`'s timer fires for an empty room, delete it instead of only
   unloading. Make the wait depend on whether anyone ever joined (2 minutes or 10). A room that is created but
   never loaded (nobody ever sent HELLO) needs its own path: a periodic sweep (every minute) that deletes rooms with
   no loaded World whose `created_at` is more than 10 minutes ago and which nobody ever joined, and rooms whose
   `last_active` is more than 2 minutes ago with no loaded World. Choose whether "ever joined" is a column or is
   derived from the tick log or snapshots; flag the choice.
3. **The startup sweep** is the same sweep run once at boot, with the same stored-time rule. A fresh room created
   30 seconds before a restart must survive the restart.
4. **Deletion is one transaction** (`rooms`, `snapshots`, `tick_log`, and any per-world rows such as `worlds` or
   incidents: check the schema), logged as `room.deleted` with the room id, mode and the reason (`empty`,
   `never_joined`), through `log.event` (it's server-triggered, not per input).
5. **Races:** a HELLO for a room whose deletion is in flight, or a join that lands between the timer firing and the
   delete, must not resurrect a half-deleted room or crash. `loadingRooms` already serialises loads; check it.

## Tests (red first, each)

- an empty played room is gone (404, not in the list, no snapshot or tick-log rows) after the grace period; use an
  injected clock or a tiny `roomUnloadMs`/`roomNeverJoinedMs` option, never a real 2-minute sleep;
- a member rejoining inside the grace period keeps it;
- a never-joined room survives 9 minutes and is gone after 10 (injected clock);
- a spectator alone keeps a room alive;
- restart: a room created just before a restart survives it; a room whose `last_active` is older than the grace
  period is gone after it;
- the fixed worlds never die.

## Commit checklist

- [ ] `last_active` kept current while occupied, with its test.
- [ ] Deletion on the empty timer and the sweep (including at boot), with the tests above.
- [ ] `docs/DECISIONS.md` row (next free D number) and `docs/research/n1-report.md` with "Architectural decisions
      for review".

## The gate

`pnpm typecheck && pnpm test:net && git commit ...` (server-only; no sim change, so the cargo and determinism steps
aren't needed; say so).
