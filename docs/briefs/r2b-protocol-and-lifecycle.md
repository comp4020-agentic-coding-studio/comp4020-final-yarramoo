# Brief R2b: rooms are joinable — protocol v9, lazy load/unload, admission caps

Written 24 Oct by the session model, after R2a landed and was pushed (`multa` at `257fdf0`). Second slice of
milestone R2 ("Rooms on the server") of `docs/plan-game-modes.md`. This is the structural slice: it changes the
wire protocol and the server's room/world lifecycle, both of which every connected client depends on. Per the
plan's own review column, **this slice gets an independent reviewer** who reads the diff cold (see the bottom of
this brief) before it is pushed.

**Scope boundary with R2a:** R2a (landed, `120075b`..`b97b57d`) built the `rooms` table and
`POST/GET /api/rooms`. Nothing in R2a is reachable from the socket path — the two fixed worlds (`/sandbox` id 0,
the cave world id 1) still work exactly as before R2a. **This brief makes rooms real**: a client can join one by
code over the socket, play in it, and the server loads/unloads the backing `World` on demand instead of keeping
two fixed instances forever.

**Scope boundary with R2c (not this brief):** re-measuring capacity (`pnpm soak:capacity`) against the room-ified
server, likely a Haiku job once this slice's shape is settled.

**Deliberately deferred past R2b** (a lighter follow-up slice, not this brief): Creative's 1-hour-archive/7-day-
delete timers, Deathmatch's delete-on-empty, Survival's delete-on-win. This brief builds the **mechanism**
(rooms load on join, unload when empty after a timeout) with one simple, uniform unload rule; the **mode-specific
timing differences** are policy layered on top once the mechanism is proven working end to end. Flag this
explicitly in your report rather than attempting all the lifecycle variations in one slice.

**Dispatch:** one Sonnet worker, medium effort, about 90 tool calls (this is a bigger slice than R2a; the brief
is correspondingly more detailed so the worker doesn't have to make protocol-shape calls on its own). Then one
independent Sonnet reviewer (medium, about 35 calls) reads the diff cold and writes
`docs/research/review-r2b.md`. The session model checks each finding against the code before acting on it.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. Read `CLAUDE.md` first (server
logging rules, no `console.*`, `log.ipTag` not raw IPs, `server/`/`shared/` never import `client/`). Then
`docs/plan-game-modes.md` section "Server: rooms instead of two fixed worlds" in full, and
`docs/research/capacity-rooms.md`'s "Recommended caps" and "Architectural decisions for review" sections (the
caps you're enforcing: 32 soft/48 hard members total, 16 loaded rooms with an L room counting as 2 slots, at most
4 L rooms, admission reads cgroup memory not RSS). The game is not live: protocol bumps and behaviour changes are
fine, nothing to migrate. Never use port 8080 for scratch servers; the Docker check uses 8093.

## What exists already (read before touching anything)

- **R0a/R1** (landed): `shared/room.ts` has the 16-byte `RoomConfig`, presets, and `SIZE_DIMS` (S 512x512, M
  1024x768, L 2048x1536). Every (terrain, size) combination in it now actually generates in the sim.
- **R2a** (landed, `120075b`..`b97b57d`): `server/rooms.ts`'s `RoomsStore` (create/get/list a room row by id or
  code; `config` is the 16 raw bytes). `GET /api/rooms/:code` already returns `{id, code, name, mode, visibility,
  config}` for a client to look up before joining.
- **The wire protocol** (`shared/protocol.ts`, `PROTOCOL_VERSION = 8`): HELLO (`C_HELLO`, `encodeHello`/decode at
  `shared/protocol.ts:372-386`) already carries a `worldId: u32` field at a fixed offset — **this field becomes
  the room id, no length or offset change needed to HELLO itself.** WELCOME (`S_WELCOME`, `encodeWelcome` at
  `shared/protocol.ts:171-182`, decode at `:422-432`) is a fixed 21 bytes and carries `worldKind: u8` (byte 13) —
  **this is what must change**: a joining client needs the room's actual 16-byte config, not a bare kind byte, to
  init its sim identically to everyone else in the room. Bump `PROTOCOL_VERSION` to 9; an old tab gets "protocol
  version mismatch: new version, reload" exactly as every prior bump has (D-094).
- **`server/world.ts`'s `World` class** (read the constructor at `server/world.ts:195-270` and `load()`/
  `loadFromDb()` at `:363-410` in full): already keyed by an `id` with `this.cfg` derived from
  `worldKindOf(this.id)` (`:267-268`). The two fixed ids (`SANDBOX_ID = 0`, `GAME_ID = 1`, `:38-39`) are
  special-cased everywhere via `worldKindOf`. A room's id (per the plan: "a room's id is its world id") needs the
  same `World` machinery but built from a room row's stored config instead of a hardcoded kind.
- **A real, size-sensitive bug already present, not introduced by you, that this slice must fix**:
  `World.acceptPos` (`server/world.ts:680`) validates a Pos against `GAME_W`/`GAME_H` from `shared/avatar.ts`,
  which are hardcoded to L's dimensions (2048x1536). Now that R1 makes Caves/Solid box/Empty box real at S and M
  too, a room at a smaller size would let `acceptPos` wrongly accept out-of-bounds positions (or reject in-bounds
  ones near the hardcoded ceiling — check which). **Fix this as part of wiring `this.cfg` through `World`**: use
  `cfg.dims()`-equivalent (`SIZE_DIMS[cfg.size]` from `shared/room.ts`) instead of the fixed constants. Write a
  test that fails against the current hardcoded constants before fixing it.
- **`server/main.ts`**'s `worlds` map (`:239` area) is currently `new Map([[SANDBOX_ID, mk(SANDBOX_ID)],
  [GAME_ID, mk(GAME_ID)]])`, built once at startup and never grown. HELLO handling (`:780-800` area) looks up
  `worlds.get(msg.worldId)` and rejects with "unknown world" if absent (`:784`). This is the lookup that needs to
  become "look up or lazily create from a room row," not a map populated once at boot.
- **`docs/research/capacity-rooms.md`**'s own "Architectural decisions for review" section already flags: caps
  count members first (not rooms), an L room counts as 2 slots, admission should read cgroup memory not RSS
  (not done yet — that's this slice's job per the plan), and a slow verify must degrade not stop the server
  (D-112 already does this correctly for the existing two worlds; make sure it still holds once rooms load
  dynamically — don't regress it).

## What to build

1. **Protocol v9.** `PROTOCOL_VERSION = 9`. `encodeWelcome`/decode change from a bare `worldKind: u8` to the
   16-byte config (replacing byte 13, growing the fixed frame from 21 to 36 bytes — pick the exact layout, keep
   every other field in the same relative order, write the byte offsets in a comment the way `encodeWelcome`
   already does). HELLO's `worldId` field is now read as "the room id to join" — no HELLO format change. Keep
   `WORLD_SANDBOX`/`WORLD_GAME`/`worldKindOf` working for ids 0 and 1 (so `/sandbox` and the existing cave world
   are unaffected), but a room id beyond those two now resolves through `RoomsStore` instead of `worldKindOf`
   returning `null`.
2. **On-demand room loading.** When HELLO names a room id that isn't 0, isn't 1, and isn't already in the
   `worlds` map: look it up via `RoomsStore.getRoomById`. Not found → `S_REJECT "unknown room"` (reuse the
   existing reject path, don't invent a new one). Found → construct a `World` for it (same `mk()` pattern as the
   two fixed worlds, but with `cfg` decoded from the room row's stored config bytes instead of derived from
   `worldKindOf`), call `await w.load()` the same as startup does for the fixed two, insert into the `worlds`
   map, then proceed with the join exactly as today. The two fixed worlds keep being created eagerly at startup
   as today — don't change their boot path, only add the lazy path for everything else.
3. **Unload when empty.** A room `World` (not `SANDBOX_ID`/`GAME_ID`, which never unload) whose member count hits
   zero starts a timer (pick a single uniform value for this slice — 2 minutes, matching the plan's Creative
   number, since you're not yet differentiating by mode); if still empty when it fires, flush, remove it from the
   `worlds` map, and free it. A join before the timer fires cancels it (the room is still "hot"). Log through
   `log.event` (add names to `shared/events.ts`'s catalogue: something like `room.loaded`, `room.unloaded`).
   **Don't build per-mode archive/delete timing in this slice** — a uniform unload-after-2-minutes-empty for
   every room is enough to prove the mechanism; mode-specific timers and the 7-day archive are the deferred
   follow-up slice.
4. **Admission caps**, from the capacity note's recommended numbers: total members across all worlds capped at
   32 soft (reject new joins past it with a clear reason, logged) / 48 hard; loaded rooms capped at 16, with an
   L-size room (per `RoomConfig.size == 2`) counting as 2 of those 16 slots and at most 4 L rooms loaded at once.
   A join that would exceed a cap gets `S_REJECT` with a reason that says which cap ("server busy", matching the
   plan's menu-facing language) — this is a server behaviour change the client will need later (R3), but the
   reject path and reason string are this slice's job. Read cgroup memory (`/sys/fs/cgroup/memory.current` on
   Linux; the capacity note flags this as not done yet) rather than `process.memoryUsage().rss` for any
   memory-based admission check, per the capacity note's own finding that RSS overstates by about 50 MB.
5. **Fix `acceptPos`'s hardcoded `GAME_W`/`GAME_H`.** Use the joining world's own `cfg`-derived dimensions
   (`SIZE_DIMS[this.cfg.size]` from `shared/room.ts`) instead of the fixed constants from `shared/avatar.ts`.
   `shared/avatar.ts`'s `GAME_W`/`GAME_H` exports can stay (other code may still use them for the fixed cave
   world specifically; check call sites before removing anything), but `World.acceptPos` must use its own room's
   actual size. Write a red-first test: a Pos within L's bounds but outside a size-S room's bounds should be
   rejected once this is fixed, and is wrongly accepted today.
6. **`GET /api/rooms/:code`'s response** (R2a, already built) is what the client fetches before joining — confirm
   the config bytes it returns round-trip correctly into a HELLO/WELCOME exchange (write a net test that does the
   full real flow: `POST /api/rooms` to create, `GET /api/rooms/:code` to fetch config, then a raw WebSocket
   client HELLOs with that room's id and gets back a WELCOME carrying the identical config bytes).

## What NOT to build (later slices' job)

- Mode-specific lifecycle timing (Creative archive/delete, Deathmatch/Survival delete rules) — the deferred
  follow-up slice mentioned above.
- The menu UI, `client/main.ts`'s room-joining flow, `/r/<code>` routing — R3.
- Creative brushes, Survival rounds, Deathmatch respawn/pickup rules — R4-R6.
- `max_players` enforcement at the sim level (D-138, someone else's job).
- `pnpm soak:capacity` re-measurement — R2c.

## Verify

- **Red first:** the `acceptPos` size bug (item 5) and the full join-a-room flow (item 6) must both be shown
  failing before their fixes land.
- **The two fixed worlds are unaffected:** every existing net test involving `/sandbox` or the cave world
  (world ids 0 and 1) must keep passing unmodified. If you find yourself editing an *existing* assertion about
  world 0 or 1's behaviour (not just adding new room-id assertions), stop and reconsider — that's a sign of
  scope creep into behaviour nothing asked you to change.
- **Protocol version bump is real:** an old-version HELLO (`version: 8`) must still get "protocol version
  mismatch: new version, reload" against the new server, the same as every prior bump.
- **A real end-to-end room join**: create a room via the R2a API, connect two raw WebSocket clients that HELLO
  with its id, confirm both get the same WELCOME config, confirm their sims produce the same state hash after
  some ticks (mirrors the existing two-client-agreement pattern in `tests/net/game.test.ts` — read it for the
  pattern rather than inventing a new one).
- **Unload actually happens**: a test that joins a room, leaves, and (with an injectable/shortened timer for the
  test, the same way other timer-based tests in this repo inject a clock) confirms the room is gone from the
  server's live state afterward, and that a later join by code loads it fresh again.
- **Admission caps are enforced**: a test that fills a room (or mocks the member-count check) past the hard cap
  and confirms the next join is rejected with a clear reason, not silently admitted.
- **Gate every commit on exit codes:**
  `pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...`
  (no `sim/` changes expected in this slice — if you do need one, add the Rust gate too, per CLAUDE.md).
- **Boot the real Docker image** and run `APP_URL=http://localhost:8093 pnpm check`. Both fixed worlds must work
  exactly as before; additionally, create a room via the API and join it with a raw WebSocket client against the
  live container to confirm the full flow works in the real deployed artifact, not just `pnpm test:net`'s
  in-process harness. Then `docker rm -f`/`docker rmi` by the literal name.

## Files you may touch

`shared/protocol.ts` (WELCOME encode/decode, `PROTOCOL_VERSION`), `shared/events.ts` (new event names),
`server/world.ts` (the `World` constructor/lazy-construction path, `acceptPos`'s size fix, unload timer),
`server/main.ts` (lazy room lookup/creation in the HELLO handler, admission cap checks), `server/rooms.ts` (only
if `RoomsStore` needs a new read method — don't change `createRoom`'s validation), `tests/net/*` (new tests, plus
updates to existing tests' WELCOME-decoding assertions where the frame genuinely grew — not behavioural changes).

Don't touch `sim/`, `shared/room.ts`'s config layout, `shared/avatar.ts`'s exported constants (read, don't
redefine), `client/`, or `server/dashboard.ts`.

## Commits (checklist; each gated)

1. [ ] Red: the `acceptPos` size bug and the full-join-flow test, both failing
2. [ ] Protocol v9: WELCOME carries the 16-byte config; `acceptPos` uses the room's own size; tests green
3. [ ] Lazy room loading: HELLO with an unknown-but-valid room id loads a `World` from `RoomsStore` on demand
4. [ ] Unload when empty (uniform 2-minute timer, not mode-specific); a reload-after-unload test
5. [ ] Admission caps (members soft/hard, loaded-room slots with L counting as 2, cgroup memory read)
6. [ ] Docker boot plus `pnpm check`, plus a manual end-to-end room-join check against the live container

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews (together with the independent reviewer below) and pushes.

## Report

Write to `docs/research/r2b-worker-report.md` as you go (append per commit). Include: what changed per commit,
red-then-green evidence, the full end-to-end two-client room test's hash-agreement evidence, the Docker check,
a section **"Architectural decisions for review"** (the exact WELCOME byte layout chosen and why, the uniform
2-minute unload timer as the deliberately-simpler stand-in for mode-specific timing, the cgroup-memory-reading
approach, anything hard-to-reverse you were unsure about where you took the more reversible option and flagged
it), and any FUTURE.md ideas written directly into `FUTURE.md`.

---

## Brief for the independent reviewer (after the worker reports)

Read the R2b commits cold (`git log` and the diffs). Don't read the worker's report. Check, and write findings
to `docs/research/review-r2b.md`:

- **Protocol v9**: does WELCOME's new layout decode correctly on the client side too (check `client/` call sites
  that read `worldKind` from WELCOME — did they get updated to read the config instead, or does something still
  expect the old byte-13 kind value)? Is the frame length check in the decoder exact, not just `>=`?
- **The `acceptPos` fix**: does every room size (S/M/L) get correctly bounded, not just the two that existed
  before? Is there a test that actually exercises a size-S or size-M room's Pos bound, not just L's?
- **Lazy loading race**: can two near-simultaneous HELLOs for the same not-yet-loaded room id both construct and
  insert a `World`, double-loading it (a classic check-then-act race)? Look for whether the lookup-or-create path
  is synchronous up to the point of insertion into the `worlds` map, or whether an `await` (e.g. `w.load()`)
  happens before the map insert, which would open exactly this window.
- **Unload correctness**: does an unload timer canceled by a join-before-it-fires actually get canceled (not
  just overwritten, leaking the old timer to fire later anyway)? Does unloading flush pending state before
  freeing the `World` (a player who leaves right as the timer fires should not lose their last few seconds of
  play)?
- **Admission caps**: are they checked *before* a `World` is constructed/loaded (so a rejected join doesn't still
  pay the cost of loading a room), or after? Can the member cap be bypassed by a spectator connection, or does it
  count every connection as the capacity note intends ("count members, not rooms")?
- **The two fixed worlds**: do they still boot and behave identically to before this slice (check their startup
  path wasn't accidentally folded into the new lazy path, which would change their behaviour on every restart)?
- **CLAUDE.md invariants**: no raw IP/token logged, every room lifecycle event goes through `log.event` with a
  catalogued name, `server/`/`shared/` still don't import `client/`.

Label each finding: severity, file:line, a concrete failure scenario, and whether you confirmed it by running
something.
