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
`sim/` changes in this slice); `pnpm test:net` results are appended per commit below.
