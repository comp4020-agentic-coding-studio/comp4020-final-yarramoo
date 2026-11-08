# Independent review: R2b (protocol v9, room lifecycle)

Reviewed cold: `git log 0f7fe56..4fdc3a4` (4 commits) and the full diff, plus targeted reads of
`server/main.ts`, `server/world.ts`, `shared/protocol.ts`, `shared/room.ts`, `server/rooms.ts`, `server/db.ts`,
`tests/net/room-join.test.ts`. Ran `pnpm typecheck` (clean) and
`pnpm vitest run --config vitest.net.config.ts tests/net/{room-join,imports,protocol,game}.test.ts`
(53/53 green) myself before writing anything below. I did not read `docs/research/r2b-worker-report.md`.

---

## Finding 1 (HIGH, confirmed by reading): a join rejected by the member cap permanently leaks a freshly-loaded room

`server/main.ts`: in the HELLO handler (around line 985-1007), `getOrLoadRoom(msg.worldId)` is awaited and —
if it had to lazily load a brand-new room — inserts the `World` into `worlds` (`server/main.ts` inside
`getOrLoadRoom`, `worlds.set(id, w)`, ~line 415) **before** the per-world cap and `memberCapReason()` checks run
(lines 993-1006). If `memberCapReason()` then rejects the join (total members at/above `MAX_MEMBERS_SOFT`/
`MAX_MEMBERS_HARD`), the handler does `return rej(capReason, msg.worldId)` and nothing else.

At that point: `w` is in `worlds`, `w.playerCount` is 0 (nobody ever called `w.join`), and `scheduleUnload(w)`
is never called — `scheduleUnload` is only invoked from `finish()` on a member actually leaving
(`server/main.ts:1063`, `if (w.playerCount === 0) scheduleUnload(w)`), which never runs because nobody joined.
The room now sits in `worlds` forever, consuming one `loadedRoomSlots()` slot (and, for an L room, 2 of 4) with
zero members and no path back to being unloaded except a server restart. Repeat this against several brand-new
rooms while the server is near the member cap and `MAX_LOADED_ROOMS`/`MAX_LOADED_L_ROOMS` is exhausted by rooms
that will never free themselves — denying service to legitimate room creators, which is exactly the resource the
cap exists to protect.

This also means the brief's own review question — "are caps checked before a World is constructed/loaded, so a
rejected join doesn't still pay the cost" — is only true for the **loaded-room-slot** cap (correctly checked
inside `getOrLoadRoom`, before construction) and **not** true for the **member** soft/hard cap, which is checked
only after the room has already been loaded and inserted. The in-code comment at lines 998-1001 even says so
explicitly ("checked here because it is cheap either way") without registering that "cheap" doesn't apply to the
*first* HELLO against a brand-new room id, where the load has already happened by the time this check runs.

**No test covers this path.** All three admission-cap tests in `tests/net/room-join.test.ts` pre-create the room
with a successful first join (`createRoom` + `connect` succeeds), then test a *second* room/join against the cap
— none exercises "first-ever HELLO to a brand-new room is rejected by the member cap," which is exactly the
scenario that leaks.

**Fix direction:** check `memberCapReason()` (and the per-world cap) before calling `getOrLoadRoom`, or pass a
`dryRun`/`precheck` so `getOrLoadRoom` never inserts into `worlds` when the caller already knows the join will
be rejected on member-count grounds. If the loaded-room-slot cap must stay inside `getOrLoadRoom` because it
needs the room's decoded config (L-vs-not), member caps should still move ahead of it since they don't need
`cfg` at all.

## Finding 2 (HIGH, confirmed by reading): `cancelUnload` fires before identity resolution can still reject the join, permanently canceling a legitimate pending unload

`server/main.ts:1007`, `cancelUnload(w.id)` runs unconditionally once the per-world and member caps pass —
**before** `identity.resolve(msg.token, gamePlayer)` at line 1013, which can still reject with `"unknown token"`
(line 1014) for a game-mode room with an invalid/missing token. If this HELLO arrives for a room that is
currently empty with its unload timer armed (last real member just left), `cancelUnload` clears that timer. The
rejected join never calls `w.join`, so `w.playerCount` stays 0, and nothing re-arms the timer (`scheduleUnload`
is only called from `finish()`, which never runs for a join that never completed). The room is now loaded,
empty, and has no scheduled unload — it leaks exactly like Finding 1, just via a different trigger (a bad-token
HELLO instead of the member cap), and it is trivially repeatable by anyone who can open a raw socket and send one
HELLO with a bogus token to a PvP/deathmatch room id right after its last real player leaves.

This directly contradicts the brief's own check: "does an unload timer canceled by a join-before-it-fires
actually get canceled (not just overwritten, leaking the old timer to fire later anyway)?" — the timer isn't
leaked in the sense of double-firing, but the room itself is leaked because nothing ever re-schedules its
unload once a failed join cancels the pending one.

No test exercises "a join to an about-to-unload room fails identity/token resolution" — `tests/net/room-join.ts`'s
unload tests only use successful joins/leaves.

**Fix direction:** only call `cancelUnload(w.id)` once the join is known to succeed (i.e., after
`identity.resolve` and the unknown-token check, immediately before/at `w.join`), not speculatively before every
cap/identity check that can still rejects.

## Finding 3 (confirmed, no bug): lazy-loading race is correctly closed

`getOrLoadRoom` (server/main.ts ~393-427) checks `worlds.get(id)` then `loadingRooms.get(id)` synchronously (no
`await` between the check and `loadingRooms.set(id, p)`), so two near-simultaneous HELLOs for the same
not-yet-loaded id: the first creates the promise and registers it in `loadingRooms` before yielding to any
`await`; the second's synchronous lookup sees that promise and awaits the same one. `worlds.set(id, w)` happens
only after `await w.load()` resolves, inside the single in-flight promise. I confirmed this by reading the
control flow line-by-line (there is no `await` between `loadingRooms.get` and `loadingRooms.set`), and the
existing join-flow and two-client-agreement tests pass, which is consistent with no double-construction. This
matches the brief's own reasoning and I found no hole in it.

## Finding 4 (confirmed, no bug): `acceptPos` fix covers S/M/L correctly

`server/world.ts:698-700` now reads `SIZE_DIMS[this.cfg.size]` instead of the fixed `GAME_W`/`GAME_H`.
`tests/net/room-join.test.ts` has a dedicated S-size test (in-bounds accepted, out-of-S-but-in-L rejected) and a
separate M-size test (in-bounds accepted, just-past-M-width rejected). Both pass under `pnpm vitest run
--config vitest.net.config.ts tests/net/room-join.test.ts` (ran myself, 13/13 green). This satisfies the brief's
"not just L" requirement.

## Finding 5 (confirmed, no bug): WELCOME's client-side decode is backward-compatible, not stale

`shared/protocol.ts`'s `decodeServer` now slices the 16-byte `cfg` out of the 36-byte frame and additionally
computes a derived `worldKind` via `kindOfWelcomeConfig` purely for `client/`'s existing call sites
(`client/worker.ts:306-307`, `m.worldKind`). I grepped every `client/` reference to `worldKind` and `.cfg` —
none reads the old byte-13 offset directly (everything goes through the decoded `ServerMsg`), and `client/`
never joins a real room yet (worldId is hardcoded to 0 or 1 in `client/main.ts:48`), so the `-1` fallback for a
real room's config is simply unreached code in the current client, which the worker's comment explicitly notes
is deferred to R3. The frame-length check is exact (`if (b.length !== 36) return null;`), not `>=`. No gap here.

## Finding 6 (confirmed, no bug): the two fixed worlds boot unaffected

`server/main.ts`'s startup (`mk(SANDBOX_ID)`, `mk(GAME_ID)`, no `cfg`/`seed` args) is unchanged in shape;
`World`'s constructor falls back to `worldKindOf(this.id)`-derived presets and the old hardcoded seeds exactly
as before when `opts.cfg`/`opts.seed` are omitted (`server/world.ts:285-287`). The "two fixed worlds are
unaffected" test block in `room-join.test.ts` (join by id 0/1, old-version-HELLO reject) passes. I also
confirmed `getOrLoadRoom` is never consulted for ids 0/1 — `worlds.get(id)` already has them at startup, so the
`RoomsStore`/placeholder-row machinery is bypassed entirely for the fixed worlds, which is correct and matches
the comment's claim.

## Finding 7 (LOW, confirmed): the id-reservation workaround is safe as implemented, but worth flagging

The two placeholder `rooms` rows (ids 0/1, `visibility: 'unlisted'`, nonsense codes) are inserted idempotently
at startup when `db` exists. I confirmed: `listPublicRooms` filters `visibility = 'public'` so these never
appear in a room listing; `getRoomByCode` can never match their reserved code strings against a real generated
6-character code (`CODE_ALPHABET` excludes underscores); and `getOrLoadRoom` never reaches `RoomsStore` for ids
0/1 anyway (Finding 6). So the workaround doesn't do anything load-bearing right now — it only matters once
`server/db.ts` gets real `AUTOINCREMENT`, which is already flagged in `FUTURE.md` per the worker's report
description (not re-verified by me, per the task's instruction not to read that report). No action needed before
push; noting it only so the reviewer record matches what's actually reachable today.

## CLAUDE.md invariants — checked

- **No raw IP/token logged**: every log site in the diff's `server/main.ts` additions uses `ipTag` (passed in
  from `log.ipTag(...)` at the call site, e.g. `ip_tag: ipTag` in the reject/join/leave paths) or room/world ids
  and byte counts — no raw IP or token bytes appear in any new `log.event`/`log.limited` call I found via
  `grep -n "console\." server/main.ts server/world.ts` (zero hits) and manual reading of every new `log.event`
  call in the diff.
- **Catalogued event names**: `shared/events.ts` adds `room.loaded`/`room.unloaded` to `EVENT_NAMES`, and both
  are used via `log.event` (not `console.*`) at the two call sites in `server/main.ts` (`getOrLoadRoom`'s
  success path, and the unload timer's fire path). `register.refused` (already catalogued) is reused for every
  new cap-rejection reason (`scope: "members_hard" | "members_soft" | "loaded_rooms" | "memory"`), which is
  consistent with the existing pattern rather than inventing new uncatalogued names.
- **`server/`/`shared/` don't import `client/`**: ran `tests/net/imports.test.ts` myself — passes (1/1) — and
  it greps the actual diff's files, not a stale list.

---

## Bottom line

**Not safe to push as-is.** Findings 1 and 2 are both real, confirmed-by-reading (not merely suspected) leaks of
loaded `World` instances with zero members and no path back to unloading — one triggered by the ordinary member
cap doing its job against a brand-new room, the other by a single bad-token HELLO timed against a room that just
emptied. Either is independently reachable by an ordinary client (no exotic timing needed for Finding 1 — it
fires on the very first over-cap join to any room nobody has joined yet) and defeats the admission-cap mechanism
this slice was built to add, since a loaded-room slot pinned this way never comes back without a restart.

Both are narrow, mechanical fixes (reorder the member-cap check ahead of `getOrLoadRoom`'s insertion for
Finding 1; move `cancelUnload` to just before the point where the join is known to succeed for Finding 2) and
each needs a new regression test (a brand-new room's first HELLO rejected by the member cap must not leave it in
`worlds`; a bad-token HELLO to a room whose unload timer is armed must not cancel that timer) before this is
pushed. Everything else checked — the lazy-load race, the acceptPos S/M/L fix, the WELCOME backward-compat
decode, the two fixed worlds' unaffected boot path, and the CLAUDE.md logging/import invariants — held up under
direct reading and the test runs I did myself.
