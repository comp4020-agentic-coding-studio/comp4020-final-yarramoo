# R2b worker report: protocol v9, lazy room load/unload, admission caps

Written by the Sonnet worker dispatched against `docs/briefs/r2b-protocol-and-lifecycle.md`. Appended per
commit as the brief asks, so a cut-off run still leaves evidence on disk.

## Scope recap

This is the structural slice: protocol v9 (WELCOME carries the room's 16-byte config), on-demand room loading
via HELLO, unload-when-empty (one uniform 2-minute timer, not mode-specific), admission caps (32 soft/48 hard
members, 16 loaded-room slots with L counting as 2, cgroup memory reads), and the pre-existing `acceptPos`
size bug fix. **Not building**: per-mode archive/delete timing (deferred follow-up), the menu UI or
`client/`'s room-joining flow (R3), `max_players` enforcement, `pnpm soak:capacity` re-measurement (R2c).

## Work in progress (this is a live append-as-I-go file)

### Protocol v9

- `shared/protocol.ts`: `PROTOCOL_VERSION` 8 -> 9. `encodeWelcome`/decode changed from a bare `worldKind: u8`
  at byte 13 to the room's 16-byte config at bytes 13..29. New fixed WELCOME layout (36 bytes, up from 21):
  `tag u8(0), playerId u32(1..5), seed u64(5..13), cfg 16 bytes(13..29), tickHz u8(29), tick u32(30..34),
  playersAtBase u16(34..36)`. HELLO is unchanged (its `worldId` field is now read as "the room id to join").
- Decode keeps a derived `worldKind` field on the decoded `ServerMsg` for back-compat with `client/`'s and
  `tests/soak/capacity.ts`'s existing call sites (none of which this slice is allowed to touch): a config that
  byte-equals one of the two fixed presets maps back to its old kind number (0/1); anything else (a real room,
  which nothing in `client/` joins yet) decodes to `-1`. This is the only reason `encodeConfig`/`decodeConfig`
  and the fixed presets now live behind a tiny lookup inside `shared/protocol.ts`.
- `tests/net/protocol.test.ts`: updated the three existing WELCOME assertions (round-trip, truncation/padding
  fuzz) to the new 36-byte frame and a real config instead of a bare kind byte — these are the "frame genuinely
  grew" updates the brief allows, not behavioural changes.

### `acceptPos` size bug

- `server/world.ts`: `World.acceptPos` validated every Pos against `GAME_W`/`GAME_H` (L's 2048x1536) regardless
  of the room's actual size. Fixed to read `SIZE_DIMS[this.cfg.size]` from `shared/room.ts`. `GAME_W`/`GAME_H`
  in `shared/avatar.ts` are untouched (still exported; no other call site reads them).

### `World` constructor generalized to any room

- `WorldOptions` gained optional `cfg` and `seed`. The two fixed worlds (ids 0/1) are unaffected: `mk()` in
  `server/main.ts` passes no `cfg`/`seed` for them, so the constructor's fallback (`worldKindOf`-derived preset,
  hardcoded seed) is exactly the old behaviour. `this.kind` (the long-standing `WORLD_SANDBOX`/`WORLD_GAME`
  switch every avatar/Pos/Cast/role code path already branches on) is now derived from `cfg.avatars === 1`
  rather than the id, so every future avatar-mode room (Deathmatch, Survival, Creative-with-avatars) gets the
  same code path without widening that switch — this generalizes an existing distinction rather than adding a
  new one.

### Lazy loading, unload, admission caps (`server/main.ts`)

- `getOrLoadRoom(id)`: resolves a HELLO's room id against the already-loaded `worlds` map, an in-flight load
  (`loadingRooms`, keyed by room id) for a second near-simultaneous HELLO, or a fresh lazy load from
  `RoomsStore.getRoomById`. The loaded-room-slot cap and the cgroup memory cap are both checked **before** the
  `World` is constructed, so a rejected join never pays the cost of loading. The `World` is inserted into
  `worlds` only after `await w.load()` finishes — see "Lazy-loading race" below for why this closes the brief's
  named race.
- `scheduleUnload`/`cancelUnload`: a uniform 2-minute (`ROOM_UNLOAD_MS`, override-able for tests) timer per
  room id, started when a room's member count hits zero (from the connection's `finish()` callback) and
  canceled on the next join to that room id (inside the HELLO resolution, before `identity.resolve`). On fire,
  it double-checks the room is still empty and still the same `World` instance (`worlds.get(w.id) === w`)
  before calling `w.shutdown()` (flushes pending ticks) and removing it from `worlds`.
- Admission caps: `MAX_MEMBERS_SOFT` (32) / `MAX_MEMBERS_HARD` (48) count every connection across every loaded
  world (`totalMembers()`), checked in the HELLO resolution path after the per-world cap and before `join()`.
  `loadedRoomSlots()` counts every non-fixed loaded room, weighting an L-size room (`cfg.size === 2`) as 2 of
  `MAX_LOADED_ROOMS` (16), with a separate `MAX_LOADED_L_ROOMS` (4) ceiling. `cgroupMemoryBytes()` reads
  `/sys/fs/cgroup/memory.current` and is skipped (not a refusal) when unavailable (anything off Linux, dev,
  CI without cgroups) so the check degrades rather than refusing every join where it cannot be read.

### A second pre-existing bug found while building the join flow: room id 1 collides with GAME_ID

Building the "full join-flow" test (`tests/net/room-join.test.ts`) surfaced a second real, pre-existing bug
beyond the one the brief named (`acceptPos`): `rooms.id` is `integer primary key` with no `AUTOINCREMENT` and
no reserved rows, so sqlite hands the very first room ever created id **1** — exactly `GAME_ID`. Before R2b,
this was invisible because R2a never let anything join a room (the socket path didn't look rooms up at all).
Once `getOrLoadRoom` is wired into HELLO, a room with id 1 would find `worlds.get(1)` already populated by the
startup-time cave world and hand the joiner the wrong world's config and live state instead of their own empty
room — confirmed directly: a throwaway script creating one room against a fresh `game.db` printed `created room
id: 1`.

`server/db.ts` (the schema) and `server/rooms.ts`'s `createRoom` (validation) are both outside this brief's
"Files you may touch" list, so the fix lives in `server/main.ts`: at startup, when a database is present, two
idempotent (`on conflict(id) do nothing`) placeholder rows are inserted directly into `rooms` for ids 0 and 1
(`visibility: 'unlisted'`, a fixed `__reserved_sandbox__`/`__reserved_game__` code nothing ever looks up),
which pushes every subsequently-created real room to id 2 or above. Confirmed with the same throwaway script:
after the reservation, the first created room's id is 2. This only affects `totalRooms()` (admin dashboard
counter, off by 2 now — no test asserts its exact value) and never `listPublicRooms()` (the two rows are
unlisted, so the public list is unaffected).

Flagged under "Architectural decisions for review" below: this is a workaround from outside the schema file,
not the real fix. The more reversible fix (an `AUTOINCREMENT` + seeded `sqlite_sequence`, or a dedicated
"reserved ids" migration) belongs in `server/db.ts` once that file is back in scope; nothing about today's
placeholder-row approach is hard to undo later.

## Red-then-green evidence

**acceptPos size bug** (`tests/net/room-join.test.ts`, "bounds a Pos against the room's own size (S)..."):
before the fix (restored the old `GAME_W`/`GAME_H` check and re-ran), the accept-an-out-of-S-but-inside-L
assertion failed red:
```
AssertionError: expected true to be false
- false
+ true
 ❯ w2.acceptPos(j2.conn, payload(1000 * POS_ONE, 1000 * POS_ONE))
```
After restoring the `SIZE_DIMS[this.cfg.size]` fix, both acceptPos tests (S-room bound, M-room bound) pass.

**Full join-flow** (`tests/net/room-join.test.ts`, "full room-join flow over the real socket"): run against the
pre-R2b tip (`git stash` back to `0f7fe56`, which has HELLO/WELCOME still mapping ids 0/1 only through
`worldKindOf`), all three tests in that describe block failed red:
```
× creates a room via the API, fetches its config, and HELLOs with its id to get a matching WELCOME
  TypeError: undefined is not iterable (welcome.cfg never arrived — the connection got "unknown world" instead)
× rejects HELLO for an id with no room row ('unknown room')
  AssertionError: expected [Function] to throw error matching /unknown room/ but got 'unknown world'
× a memory-only server (no RoomsStore) also refuses an unknown/room id cleanly
  AssertionError: expected [Function] to throw error matching /unknown room/ but got 'unknown world'
```
`git stash pop` restored the R2b changes; all 13 tests in the file (acceptPos + full join flow + fixed-worlds
+ two-client agreement + unload + admission caps) pass:
```
Test Files  1 passed (1)
     Tests  13 passed (13)
```

## Two-client room agreement (end-to-end hash evidence)

`"mirrors the two-client-agreement pattern for a freshly created room"`: creates a size-S Caves/avatar room via
the real `POST /api/rooms`, connects two real WebSocket test clients (one playing, one spectating) that both
HELLO with the room's id, runs real ticks, and compares the state hash each client's own sim computed at every
tick both recorded. Passing run: `common.length` (shared hash-checkpoint ticks) was non-zero and every one
matched (`expect(b.hashes.get(t)).toBe(a.hashes.get(t))` for every `t`), confirming both clients' sims, started
from the identical 16-byte config carried in WELCOME, step to byte-identical state.

## Fixing exit codes used for every commit gate

`pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...` — never `;` or a grep-piped
check, per CLAUDE.md. `pnpm typecheck` is clean throughout; `pnpm test:determinism` is 41/41 unaffected (no
`sim/` changes in this slice).

A first full `pnpm test:net` run found one more existing-test assertion that needed a genuine (not cosmetic)
update: `tests/net/game.test.ts`'s "clients cannot Join, Leave or Paint in the game world, and an unknown
world is refused" asserted `connect(..., { world: 7 })` throws `/unknown world/`. Per the brief's item 2, an
id beyond the two fixed worlds now resolves through `RoomsStore` and rejects with "unknown room" when no row
exists — this is the intended new behaviour for every id except 0/1, not a change to world 0/1's own
behaviour, so it's exactly the kind of test update the brief allows rather than the "stop and reconsider"
case (which is reserved for edits to an assertion *about world 0 or 1 itself*). Updated the assertion and
re-ran: full suite green.

Two full `pnpm test:net` runs: the first (before the `game.test.ts` fix) was 297/298 (one known failure,
above); after the fix, **298/298 passed, 37/37 files**, exit code 0.

## Docker check and manual end-to-end room-join against the live container

`docker build -t r2b-worker-check -f Dockerfile .` succeeded (three-stage build, consistent with
CLAUDE.md's "server/ and shared/ never import client/" — the runtime image only copies `server/`+`shared/`).
Ran on port 8093 (never 8080, per repo convention): `docker run -d --name r2b-worker-check -p 8093:8093 -e
PORT=8093 r2b-worker-check`. `server.start` logged with `"protocol":9` and the real build hash.

`APP_URL=http://localhost:8093 pnpm check`:
```
$ pnpm typecheck && pnpm test
$ tsc --noEmit
 Test Files  2 passed (2)
      Tests  9 passed (9)
```

Manual end-to-end room-join against the live container (not `pnpm test:net`'s in-process harness):
```
$ curl -s -i -X POST http://localhost:8093/api/rooms -d '{"name":"Docker Check Room","mode":"deathmatch","config":"AQACAQIAAAADAQAIAAAAAA==","visibility":"public"}'
HTTP/1.1 201 Created
{"id":2,"code":"MBET3N","name":"Docker Check Room","mode":"deathmatch","visibility":"public"}
```
Room id **2**, not 1 — confirms the id-reservation fix (see below) actually works against the real schema in
the real container, not just an in-memory test database.
```
$ curl -s http://localhost:8093/api/rooms/MBET3N
{"id":2,"code":"MBET3N","name":"Docker Check Room","mode":"deathmatch","visibility":"public","config":"AQACAQIAAAADAQAIAAAAAA=="}
```
A raw WebSocket client (built outside the test harness, using the container's own `sim.wasm` for the build
hash, extracted via `docker cp`) HELLOed with room id 2, flags=1 (spectate, no identity needed):
```
WELCOME ok, frame length: 36 (expect 36)
playerId: 0 seed: 2
config bytes (base64): AQACAQIAAAADAQAIAAAAAA==
```
The WELCOME frame is 36 bytes (the v9 layout) and its config bytes are byte-identical to what was POSTed at
room creation — the real join flow round-trips correctly in the deployed artifact. Container logs confirm:
```
{"ev":"room.created","room":2,"mode":"deathmatch","visibility":"public"}
{"ev":"room.loaded","world":2,"code":"MBET3N","mode":"deathmatch","size":2}
```
`GET /api/summary` lists worlds `[0, 1, 2]` — the loaded room appears alongside the two fixed worlds.
Container and image removed by their literal names afterward: `docker rm -f r2b-worker-check` then `docker
rmi r2b-worker-check` (no variables, no globs, per CLAUDE.md's explicit-rm-path rule).

## Architectural decisions for review

1. **WELCOME byte layout.** `tag u8(0), playerId u32(1..5), seed u64(5..13), config 16 bytes(13..29), tickHz
   u8(29), tick u32(30..34), playersAtBase u16(34..36)` — 36 bytes fixed, up from 21. The config simply
   replaces the old `worldKind: u8` at byte 13 and every field after it shifts down by 15 bytes (16 - 1, the
   config's length minus the byte it replaces), keeping every field's *relative order* exactly as before (the
   brief's instruction). Alternative considered: putting the config at the *end* of the frame instead of
   splicing it into the middle, which would have kept every earlier field's offset unchanged and only
   `playersAtBase` would move. Chose the splice-in-place layout anyway because it keeps the frame's field
   order matching its conceptual order (identity, then "what world is this", then timing) the way the old
   `worldKind` position already did, and because nothing outside `encodeWelcome`/`decodeServer` reads a raw
   byte offset directly (every call site goes through the decoded `ServerMsg` object) so no one else's offset
   math breaks either way. Reversible: this is a wire format, not a stored one (WELCOME is never persisted),
   so a later slice can re-lay it out with no migration cost.

2. **The uniform 2-minute unload timer as a deliberately simpler stand-in for mode-specific timing.** The plan
   specifies different lifecycles per mode (Creative: 2-min-unload/1-hour-archive/7-day-delete; Deathmatch:
   delete-on-empty with no archive; Survival: delete-on-win-or-empty). This slice builds only the *mechanism*
   — a room (not the two fixed worlds) unloads from memory 2 minutes after its last member leaves, reloads
   fresh from its stored row on the next join — using Creative's own 2-minute number as the one uniform value,
   per the brief's explicit instruction. This is the most reversible choice available: "unload after N minutes
   empty" is one `setTimeout` whose duration can become mode-dependent (`cfg`-derived) without touching its
   cancel/fire logic at all, and nothing about archiving or deleting a row is built yet, so there's no delete
   behavior to later walk back. Logged as its own FUTURE.md entry.

3. **The cgroup-memory-reading approach.** `cgroupMemoryBytes()` reads `/sys/fs/cgroup/memory.current` directly
   (cgroup v2; the capacity note's own measurement path) and is treated as *advisory, not required*: when the
   file can't be read (anything off Linux, a dev machine, CI without cgroups), the memory check is skipped
   rather than refusing every room load. This matches the capacity note's finding that RSS overstates cgroup
   usage by about 50 MB, and keeps the existing `/api/summary` RSS-based 200 MB warning (`server/main.ts`'s
   `process.minute`) completely untouched — this slice adds a *second*, independent cgroup-based admission
   check rather than replacing the RSS one, since the brief's "Files you may touch" list doesn't include that
   warning's surrounding code and changing it wasn't asked for. Flagged as a candidate to unify later (the
   capacity note's own item 3 under its "Architectural decisions for review": "changing the 200 MB warning to
   read cgroup memory is a server change, not done here" — still not done here either, now logged twice).

4. **Hard-to-reverse choices where the more reversible option was taken, flagged:**
   - **Per-room seed = room id**, not a real random seed, because `rooms` has no `seed` column yet and
     `server/db.ts` is out of this brief's file list. Flagged in detail above and in `FUTURE.md`; reversible
     at zero cost later since no room's generated state is live yet.
   - **Room id-space collision workaround lives in `server/main.ts`, not `server/db.ts`.** The real, more
     permanent fix (an `AUTOINCREMENT` + seeded `sqlite_sequence`, or a migration-time reservation) belongs in
     the schema file; today's idempotent placeholder-row insert at startup is a correct but not final fix,
     logged in `FUTURE.md` so whoever next touches `server/db.ts` folds it in properly.
   - **`World.kind` now derived from `cfg.avatars` instead of the world id.** This generalizes an existing
     distinction (every `WORLD_SANDBOX`/`WORLD_GAME` branch in `server/world.ts` and `server/main.ts`) to work
     for any room, not just the two fixed ones, without inventing new branching. The alternative — leaving
     `kind` tied to `worldKindOf(id)` and adding a *third* concept ("is this an avatar room") everywhere that
     today checks `kind === WORLD_GAME` — would have meant touching every one of those call sites twice (once
     now, once when a real mode taxonomy lands in a later milestone). Chosen because it's strictly fewer
     moving parts today and doesn't foreclose a richer mode taxonomy later (nothing stops a future slice from
     deriving `kind` from `cfg.terrain`/`cfg.round`/etc. too, alongside `cfg.avatars`).

## FUTURE.md entries written this slice

Four new entries added directly to `FUTURE.md` (not just mentioned here, per CLAUDE.md): "Live player counts
and a real sort for the public room list" (updated the existing R2a entry — now buildable since rooms load
into real `World`s with a live count), "Reserve the rooms table's id space properly, in server/db.ts", "Per-
mode room lifecycle timing (Creative archive/delete, Deathmatch/Survival delete-on-empty)", and "A real
per-room seed, not the room's own id."

## Final state

Three code commits on `multa` (plus this report's own commit), each gated on `pnpm typecheck && pnpm
<targeted-or-full-test> ` exit codes, never `;` or grep-piped output:

1. `R2b (1/6): red — tests/net/room-join.test.ts against the pre-R2b server`
2. `R2b (2/6): protocol v9 — WELCOME carries the room's config; acceptPos uses the room's own size`
3. `R2b (3/6): lazy room loading, unload-when-empty, admission caps (checklist items 3-5)`

Checklist items 3, 4 and 5 landed in one commit (see that commit's message for why — they share one code path
in `server/main.ts` and don't compile to a coherent intermediate split three ways). Item 6 (Docker boot, `pnpm
check`, manual end-to-end check) is done and reported above, as its own final verification step rather than a
fourth code commit (nothing needed fixing).

Full final gate: `pnpm typecheck` clean, `pnpm test:determinism` 41/41 (unaffected — no `sim/` changes),
`pnpm test:net` 298/298 (37 files), Docker build + boot + `pnpm check` (9/9) + manual room-join all green.

Files changed (all within the brief's "Files you may touch" list): `shared/protocol.ts` (WELCOME layout,
`PROTOCOL_VERSION`), `shared/events.ts` (`room.loaded`, `room.unloaded`), `server/world.ts` (`World`
constructor `cfg`/`seed` options, `acceptPos`'s size fix), `server/main.ts` (lazy room lookup/load, unload
timers, admission caps, the id-reservation workaround), `tests/net/room-join.test.ts` (new),
`tests/net/helpers.ts`, `tests/net/protocol.test.ts`, `tests/net/achievements-live.test.ts`,
`tests/net/lockstep.test.ts`, `tests/net/game.test.ts` (existing-test updates, all either frame-growth or the
intended new "unknown room" behaviour, not scope creep into world 0/1's own behaviour). `server/rooms.ts` was
**not** touched (no new read method was needed — `getRoomById` already existed from R2a). Nothing in `sim/`,
`shared/room.ts`'s config layout, `shared/avatar.ts`'s exported constants, `client/`, or `server/dashboard.ts`
was touched. Not pushed — left for the session model and the independent reviewer.
