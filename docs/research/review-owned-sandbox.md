# Review: owned persistent sandbox (server/ + shared/ diff vs multa)

Read-only cold review. Tests were not run (no vitest, no gate).

## Findings

### N1 server/rooms.ts:231-234 (ensureOwned) with server/main.ts:~945 (POST /api/sandbox): owned rooms are unbounded and pin registrations
`ensureOwned` sets `players.joined_at`, so `evictUnjoined` never removes that player, and `staleRooms` skips every owned row, even one nobody ever joined. `POST /api/players` is open (60/min global), then one `POST /api/sandbox` per token, limited only by the per-IP 10/hour bucket (keyed on the spoofable-off-Fly `fly-client-ip` / socket address). Each such call permanently consumes one of `MAX_REGISTERED` (900) slots and one DB row. A modest botnet, or a long slow trickle, fills the registration cap with unevictable players, so real players can no longer register (identity.ts:44-47), and the DB grows without bound.
Fix: cap total owned rooms (say 200) and refuse beyond it with 429/503; and/or sweep an owned room that was never joined after N days (`first_joined_at is null and created_at < ?` for owned rows only), and leave the player evictable again by not setting `joined_at` until the first real join (`markJoined`), as long as the FK is handled (see M3).

### N2 server/main.ts:~958-966 (DELETE path) : no try/catch around `deleteRoom` / `ensureOwned`
`deleteRoom` closes sockets, calls `w.shutdown()` and `worlds.delete` BEFORE `rooms.deleteRoom(id)`, which can throw (SQLITE_BUSY after the 5 s timeout, disk full). The throw escapes the http request handler (an uncaught exception; production rethrows on unhandledRejection and the uncaughtException default kills the process). Memory is then already torn down while rows remain, and `room.deleted` is not logged. `ensureOwned` also ends in `throw e` for non-UNIQUE errors, same exposure.
Fix: wrap the owned route body in try/catch returning 500 and a `log.limited` error; in `deleteRoom`, do `rooms.deleteRoom(id)` inside a try, and only after it succeeds tear down memory (or on failure leave the world unloaded and the rows to be retried).

### N3 server/main.ts:1427 + 391-398: timer armed for an already-deleted room (owner delete with members)
Owner delete closes members and calls `w.shutdown()`, which removes members; the close events later run `finish()`, whose tail does `if (w.playerCount === 0) scheduleUnload(w)`. This arms `roomUnloadTimers[id]` for a world no longer in `worlds`. The callback is harmless (`worlds.get(w.id) !== w` returns), so correctness holds, but sqlite reuses ids: if a new room with that id loads within the grace period, its own `scheduleUnload`/`cancelUnload` is fine, yet the stale entry lingers for up to the unload period and `finish` also calls `rooms.touch` on a gone row (no-op). Cheap fix: in `scheduleUnload` return if `worlds.get(w.id) !== w || w.closing`.

### M1 server/main.ts:~931 : one log key `owned:${ipTag}` shared by create_rejected and delete_refused
Within 10 s a `create_rejected` suppresses a `delete_refused` from the same IP (and vice versa); the suppressed counter is attached only to the next event of whichever name comes next. Use per-event keys (`owned_del:`, `owned_create:`).

### M2 server/main.ts:~939: the owner's own delete is not logged with who
`room.deleted` logs only `reason: "owner"`; add `who: name#id` (legal in logs) for the audit trail, since delete is a trust path. Also `deleteRoom` returning false for an id <= 1 would show as 409 "busy"; unreachable since owned rows are never ids 0/1.

### M3 server/db.ts migration: FK exposure to player deletion
Only `evictUnjoined` deletes players, and `ensureOwned` protects the owner by setting `joined_at`, so no current path throws. But it is a coupling: any future "delete player" path (admin reset of identity, a DB reset that deletes `players` but not `rooms`) will throw on `rooms.owner_player_id` / `creator_player_id`. If N1 is fixed by not setting `joined_at`, `evictUnjoined` must instead exclude `id in (select owner_player_id from rooms)`. Note the `update players` in `ensureOwned` is not in the same transaction as the insert (crash between them leaves an evictable owner, which then makes the next evictUnjoined throw; wrap both in BEGIN/COMMIT).

## Checked and sound
- Only the owner (token -> player id equals `owner_player_id`) reaches `deleteRoom(.., "owner")`. The unload timer, `sweepRooms` (SQL `owner_player_id is null` and the guard inside `deleteRoom`), `staleRooms`, `discardIfFreshlyLoaded` (unloads only, never deletes rows), and `failWorld` (drops memory only) cannot delete an owned room's rows. Survival/Deathmatch/shared sandbox rooms keep `owner_player_id` null and behave exactly as before (the unload branch is `ownerPlayerId == null`).
- DELETE racing a mid-load HELLO: `deleteRoom` returns false while `loadingRooms.has(id)` and the route answers 409 (retryable); a HELLO landing after the delete finds no row and gets "unknown room". A HELLO that already got its World is synchronous up to `w.join`, so it cannot interleave. Snapshot verify in flight: `shutdown()` sets `closing` before rows go (line 1551 guard), and `shutdown` flushes first.
- One per player: partial unique index, `ownedBy` lookup, and UNIQUE-race fallback in `ensureOwned`; POST is idempotent and the per-IP bucket is consumed only on a real create. No takeover: the code in the path must match `/^[A-Za-z0-9]{1,6}$/` (reserved `__reserved_*` rows excluded), lookup is case-insensitive by design, and a mismatch is 403 `not_owner` (existence of a code is not secret). Bearer parsed by strict regex of 64 lowercase hex.
- Delete leftovers: rows (snapshots, tick_log, desync_incidents, worlds, rooms) in one transaction; `worlds`, `tickSamples`, unload timer, members closed with 4003 (the client worker handles 4003). `live` entries are removed by the close events.
- Unloaded owned room reloads from its snapshot/tick log through the normal `getOrLoadRoom`; slot and memory caps still apply to it (no bypass). It is excluded from the public list and `liveRoute`.
- Logging: `room.delete_refused` is in `shared/events.ts`; refusals go through `log.limited`; ip as `ipTag`; no tokens; `name#id` only in log fields; responses carry the plain room name ("Name's world", at most 24+8 characters, fits 32).
- Origin check on POST/DELETE; GET is read-only and token-gated.

## Architectural decisions for review
1. Owned rooms exempt from the sweep entirely, including never-joined ones: consider a long (30 day) never-joined sweep and a global cap (N1).
2. Reusing `joined_at` to shield the owner from eviction ties identity retention to room ownership; an explicit exclusion in `evictUnjoined` is the more reversible, self-documenting choice (M3).
3. Owner delete tears memory down before the DB commit; the reverse order (commit rows, then tear down) fails safer (N2).
