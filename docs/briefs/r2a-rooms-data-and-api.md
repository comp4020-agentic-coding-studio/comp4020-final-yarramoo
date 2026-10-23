# Brief R2a: rooms table and HTTP API (no protocol change, no lifecycle yet)

Written 24 Oct by the session model. First slice of milestone R2 ("Rooms on the server") of
`docs/plan-game-modes.md`. R2 is the plan's largest and riskiest milestone — it touches `server/world.ts`
(1311 lines), `server/main.ts` (1006 lines), `shared/protocol.ts` and eventually `client/main.ts`, all of which
every other part of the running server depends on. Per CLAUDE.md, a coupled multi-user surface like this does not
get fanned out to parallel workers, and per the plan's own review column R2 needs an independent reviewer before
anything structural merges. The session model has split R2 into three sequential slices so each is small enough
to review properly:

- **R2a (this brief):** the `rooms` table, `shared/room.ts`-style validation on the server, and the
  `POST/GET /api/rooms` HTTP API. Rooms are created and listed, but **joining a room still goes through the
  existing protocol** — no room is actually playable yet, because WELCOME still only carries a world id/kind, not
  a room's config. This is deliberately inert: it proves the data model and API in isolation before anything
  touches the live socket path.
- **R2b (next, not this brief):** protocol v9 (WELCOME carries the config; HELLO joins by room code/id), lazy
  load/unload of `World` instances, admission caps from the capacity note. This is where rooms become real and
  where the independent reviewer reads the diff cold (protocol + lifecycle, per the plan's review column).
- **R2c (after R2b, not this brief):** re-run `pnpm soak:capacity` against the room-ified server and update
  `docs/research/capacity-rooms.md` with real numbers instead of the two-fixed-world baseline. Likely a Haiku job
  (run a known command, report its output) once R2b's shape is settled.

**Dispatch:** one Sonnet worker, medium effort, about 70 tool calls. No independent reviewer for R2a specifically
(it never touches the socket protocol or the tick clock) — the session model reviews the diff itself, the same
way R1's terrain work was reviewed. R2b gets the independent reviewer.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. Read `CLAUDE.md` first (server
logging rules are binding: every server action logs through `log.event` with a name from `shared/events.ts`, never
raw `console.*`; never log a raw IP or token, use `log.ipTag`; `server/` and `shared/` never import from
`client/`). Then `docs/plan-game-modes.md` section "Server: rooms instead of two fixed worlds" in full. Then
`docs/research/capacity-rooms.md`'s "Recommended caps" section (R2b's job to enforce, but good context for sizing
this slice's schema and API shapes correctly now). The game is not live: schema changes are fine, nothing to
migrate. Rust is not involved in this slice at all — this is TypeScript only. Never use port 8080 for scratch
servers; the Docker check in this brief uses 8093 per the repo's convention.

## What exists already (read before touching anything)

- **R0a** put a 16-byte `RoomConfig` behind the sim ABI (`shared/room.ts`: `RoomConfig`, `CONFIG_FIELDS`,
  `encodeConfig`/`decodeConfig`, presets `CLASSIC_SANDBOX`/`CAVES_PVP`). This is the config a room will eventually
  carry. Read `shared/room.ts` in full — this slice's room-creation validation reuses it directly, it does not
  reinvent field ranges.
- **R1** made every (terrain, size) combination in that config actually generate in the sim. So a room's config
  can now legitimately ask for any of the 9 terrain/size combinations, not just the two presets.
- **`server/db.ts`** is the existing SQLite layer (`node:sqlite`, WAL). `MIGRATIONS` is an append-only array under
  `PRAGMA user_version` (read the whole file — it's not long). The existing `worlds` table
  (`id, kind, seed, sim_build, last_tick, next_player, created_at`) is keyed by world id; per the plan, **a
  room's id is its world id**, so rooms extend this table rather than replacing it.
- **`server/world.ts`**'s `World` class (read the constructor, `server/world.ts:195-270`) currently hardcodes two
  world ids (`SANDBOX_ID`, `GAME_ID` from `worldKindOf`) and derives `this.cfg` from a bare kind
  (`this.kind === WORLD_GAME ? CAVES_PVP : CLASSIC_SANDBOX`, line 268). **Do not change this in R2a** — that
  wiring is R2b's job (it's exactly the lazy-load/protocol work this slice is deliberately not doing yet).
- **`server/main.ts`** wires the two fixed worlds at startup (`server/main.ts:226` area) and has the existing
  `GET /api/summary`, `/dashboard`, etc. routes as examples of the HTTP routing pattern already in use (read how
  an existing GET route is wired before adding new ones, so R2a's routes match the house style).
- **`shared/events.ts`** is the event-name catalogue CLAUDE.md requires every `log.event` call to draw from —
  read it, and add room-related event names there (not ad-hoc strings).

## What to build (R2a only — see "What NOT to build" below)

1. **`rooms` table** (new migration, appended to `server/db.ts`'s `MIGRATIONS` array, never editing an existing
   entry): `id integer primary key` (equals the world id it will eventually back), `code text unique not null`
   (6 characters, from `crypto.randomBytes`, not sequential — unlisted rooms must not be enumerable by guessing
   nearby ids), `name text not null` (room name, user text, capped at 32 characters), `mode text not null` (one
   of the plan's four preset names: `survival`, `deathmatch`, `creative`, `sandbox`), `config blob not null` (the
   16-byte encoded `RoomConfig`), `visibility text not null check (visibility in ('public','unlisted'))`,
   `creator_player_id integer` (nullable — an anonymous creator has none), `created_at integer not null`,
   `last_active integer not null`. Don't add archival/deletion columns yet (`archived_at`, etc.) — that's R2b's
   lifecycle work; this slice only needs enough schema to create and list a row.
2. **`server/rooms.ts`** (new file): the room data-access and validation layer, analogous to `server/stats.ts` or
   `server/identity.ts` in shape (read one of those for the house pattern: a class wrapping prepared statements,
   constructed with the `GameDb`/`DatabaseSync` handle). Functions/methods needed:
   - `createRoom(opts)`: validates `name` (trim, strip control/bidi characters the same way `cleanName` in
     `shared/protocol.ts` or `server/main.ts` already does for player names — reuse that function, don't
     reimplement it), caps it at 32 code points, validates `config` bytes through `shared/room.ts`'s
     `decodeConfig` (reject with a clear reason if it fails — a bad config must never reach a stored row), checks
     `mode` is one of the four known presets, generates a unique 6-character code (retry on a rare collision),
     inserts the row, returns it.
   - `getRoomByCode(code)`, `getRoomById(id)`: lookups, case-insensitive on the code (the plan says "six
     characters, case-insensitive").
   - `listPublicRooms()`: rows where `visibility = 'public'`, ordered by the plan's rule ("sorted by players,
     then most recent" — player counts don't exist yet in this slice since no room is actually joinable, so sort
     by `last_active` descending only for now and leave a `// TODO(R2b): sort by live player count first` comment
     rather than inventing a fake count).
   - Rate limiting: "3 rooms created per visitor per day" (plan) — needs a `creator_player_id` + day-bucket check
     before insert; an anonymous creator (`creator_player_id` null) has no limit tracked in this slice (R2b, once
     joining is real, is where an anonymous creator even makes sense to rate-limit by IP — flag this gap in your
     report rather than building IP-based limiting now).
3. **HTTP API** in `server/main.ts` (or a new `server/rooms-api.ts` if `main.ts`'s existing routing pattern makes
   that cleaner — follow whichever the existing code does for routes like `/api/players`):
   - `POST /api/rooms`: body `{name, mode, config (base64 or hex of the 16 bytes), visibility}`. Validates via
     `server/rooms.ts`, returns `201 {id, code, name, mode, visibility}` or a `4xx` with a clear reason on
     validation failure. Same body-size caps and origin checks the existing `/api/players` route uses (read it
     for the pattern — CSRF-style origin checking, size limits).
   - `GET /api/rooms`: returns public rooms only, as the plan specifies: `{id, code, name, mode}` — **no player
     names, no live counts yet** (R2b adds counts once joining is real). Paginate or cap at a sane number (the
     capacity note's "100 stored rooms" cap means this never needs to be huge, but don't return an unbounded
     `select *`).
   - `GET /api/rooms/:code`: the config and world id for joining (still inert in R2a — nothing can actually join
     yet, but the shape should already match what R2b's client code will need to call).
   - Every route logs through `log.event` with a new event name added to `shared/events.ts` (e.g.
     `room.created`, `room.create_rejected` with a reason, `room.listed` only if listing is noteworthy — probably
     not, to avoid flooding logs on a 5 s poll; check CLAUDE.md's `log.limited` guidance for anything a client can
     call repeatedly).
4. **Admin visibility**: a minimal addition to `server/dashboard.ts`'s existing admin view — a count of stored
   rooms by mode, nothing elaborate (the plan's "rooms panel" is R2b/R7 polish once rooms are actually live;
   R2a only needs enough that an admin can see rooms exist without `sqlite3 game.db` by hand).

## What NOT to build (R2b's job, not this slice)

- Anything on the socket/protocol path: HELLO, WELCOME, joining a room by code, `World` instances keyed by room
  id instead of the two fixed ids. The two fixed worlds (`/sandbox`, `/` today's cave world) keep working
  exactly as they do now; this slice adds a second, independent, currently-unused system next to them.
- Lazy load/unload of `World` instances, the "2 minutes empty" / "1 hour archive" / "7 days delete" lifecycle,
  the Deathmatch/Survival deletion rules. All of that needs a `World` that's actually backed by a room, which
  doesn't exist until R2b.
- Admission caps (32/48 members, 16 loaded rooms, etc.) — there's nothing to admit into yet.
- Protocol version bump. `PROTOCOL_VERSION` stays 8.
- The menu UI (`client/`) — R3's job. Nothing in `client/` changes in this slice.

## Verify

- **Red first:** write `tests/net/rooms.test.ts` against the not-yet-existing `server/rooms.ts` and API routes
  before implementing (import errors or 404s are an acceptable "red", the same pattern R0a used for its new
  module).
- **Validation is real, not decorative:** a config that `decodeConfig` refuses must make `POST /api/rooms` refuse
  too — write a test with a deliberately bad config byte and confirm the API rejects it with a 4xx, not a 500 and
  not a silently-stored bad row.
- **Code uniqueness:** a test that creates enough rooms to make a collision plausible (or mocks the random source
  to force one) and confirms the retry produces a second, different code rather than a constraint-violation
  crash.
- **Existing behaviour untouched:** `pnpm test:net`'s existing 270 tests must all still pass unmodified — this
  slice only adds, it doesn't touch the Working two-world path. If you find yourself editing `server/world.ts` or
  `server/main.ts`'s existing socket-handling code, stop and reconsider — that's a sign you've drifted into R2b's
  scope.
- **Gate every commit on exit codes:**
  `pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...`
  (no `sim/` changes in this slice, so no Rust gate is needed, but run `pnpm test:determinism` anyway since it's
  part of the repo's standard gate and costs only ~2 minutes).
- **Boot the real Docker image** and run `APP_URL=http://localhost:8093 pnpm check`. The two existing worlds must
  keep working exactly as today; additionally hit `POST /api/rooms` and `GET /api/rooms` against the live
  container with `curl` to confirm the new routes actually work end-to-end in the real deployed artifact, not
  just in `pnpm test:net`'s in-process harness. Then `docker rm -f`/`docker rmi` by the literal container/image
  name you used.

## Files you may touch

`server/db.ts` (new migration only — append, never edit an existing migration string), `server/rooms.ts` (new),
`server/main.ts` (new routes only — do not touch the existing WebSocket/HELLO/tick-clock code), `server/dashboard.ts`
(the new rooms count panel only), `shared/events.ts` (new event names only), `tests/net/rooms.test.ts` (new).

Don't touch `sim/`, `shared/room.ts`, `shared/protocol.ts`, `shared/sim.ts`, `client/`, or any existing test file
other than adding new `it`/`describe` blocks if genuinely necessary (prefer a wholly new test file).

## Commits (checklist; each gated)

1. [ ] Red: `tests/net/rooms.test.ts` against the not-yet-built API
2. [ ] `rooms` table migration plus `server/rooms.ts` (create/get/list, validation, rate limit), tests green
3. [ ] `POST/GET /api/rooms` and `GET /api/rooms/:code` wired in `server/main.ts`, tests green
4. [ ] Admin dashboard rooms-count panel
5. [ ] Docker boot plus `pnpm check`, plus a manual `curl` check of the new routes against the live container
       (no commit unless a fix is needed)

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews and pushes.

## Report

Write to `docs/research/r2a-worker-report.md` as you go (append per commit). Include: what changed per commit,
red-then-green evidence, the manual curl output against the Docker container, a section **"Architectural
decisions for review"** (the rate-limit gap for anonymous creators flagged above, the room-listing sort-order
placeholder, anything else hard-to-reverse you were unsure about where you took the more reversible option), and
any FUTURE.md ideas written directly into `FUTURE.md`.
