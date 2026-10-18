# Review: crit 10 slice 2 (names, stats, input summaries)

Diff: `33d3f1b..d6bc59f`. `pnpm typecheck` is green. `pnpm test:net` is green (12 files, 80 tests, 117 s).
Reviewed cold, no source changed.

## S: must fix before pushing

### S1. Production image will not start: server now imports client source that the runtime stage does not copy
- `shared/stats.ts:3-4` imports `../client/materials.ts` and `../client/spells.ts`.
- `server/main.ts` imports `../shared/stats.ts`, and so does `server/world.ts`.
- The runtime stage of `Dockerfile` copies only `server`, `shared`, `README.md`, the wasm and `dist/client` (the built bundle). It does not copy `client/*.ts`.
- `node server/main.ts` therefore dies with `ERR_MODULE_NOT_FOUND` on the first import. Tests and `pnpm check` run from the working tree, so they cannot see this. CI deploys through this Dockerfile.
- Fix, either:
  - Move the material and spell name tables into `shared/` (for example `shared/names.ts`) and have the client import them from there. This is the cleaner fix, and it keeps server code off client modules. `client/spells.ts` also imports `shared/sim.ts`, so check that nothing else is dragged in.
  - Or add `COPY client/materials.ts client/spells.ts ./client/` to the runtime stage. This is fragile.
- Add a check that `server/` and `shared/` never import from `../client`, for example a grep in `pnpm check`. Better still, boot the server from a tree that has only those directories.

## N: should fix

### N1. Every visitor now registers and HELLOs in the sandbox, so the 900-player cap fills permanently
- `server/main.ts` (HELLO) calls `identity.resolve`, which calls `db.touchPlayer`, which sets `joined_at` on the first HELLO with a token. This now happens for sandbox painters and spectators too.
- `client/main.ts:593` makes every visitor register.
- D-069 evicts only never-joined rows, and only when the cap is hit. After this change nearly every registration has `joined_at` set, so nothing is ever evictable.
- After 900 casual visitors, `/api/players` returns null (cap) forever, and every new visitor sees a form that fails.
- The exposure was smaller before, because the sandbox did not register at all.
- Fix options:
  - Do not stamp `joined_at` for sandbox or spectator HELLOs. Split `resolve` into a pure lookup and a `touch` that runs only for game-world players.
  - Or evict by `last_seen`/age for rows that have no `joined_at` or no stats.
  - Or raise or rework the cap, and record it in `docs/DECISIONS.md`.
- Foreign-key check: stats are only written for ids that HELLO-resolved, and HELLO stamps `joined_at`. So `evictUnjoined` (`delete from players where joined_at is null ...`, `foreign_keys = ON`) can never hit a row that has stats. That part is fine today. It is the same coupling that causes this finding. If the eviction rule is changed, the FK on `player_stats.player_id` will make the whole `delete` throw. Then also delete the stats rows, or drop the FK.

### N2. A poison row makes `PlayerStats.flush` fail forever and log once a second
- `server/stats.ts` flush: on error the dirty set is kept (good) and an `error` event is emitted every 1 s, with no `limited`.
- A persistent failure (FK violation after a manual row delete, a disk-full or locked DB) means an unbounded error flood in the 5000-entry ring buffer and on stdout. The one bad row also blocks every other player's counters.
- Fix: use `log.limited("stats.flush", 10_000, ...)`. Optionally fall back to per-row writes after a batch failure so one bad id cannot starve the rest.
- Also in `GameDb.upsertStats`: if `BEGIN` itself throws, the `ROLLBACK` in the catch can throw too and mask the original error. This is only an edge case.

## M: minor

- M1. `server/main.ts` (`finish`): `playerStats.max(visitorId, STAT_MAX_DEPTH, j.counts.maxDepth)` runs for every session, so sandbox painters and spectators write a `max_depth = 0` row (`max()` accepts 0 over `-Infinity`). Harmless but noisy. Skip it when `counts.pos === 0`.
- M2. `play_ms` is added per connection. The same token in the sandbox and the game at once, or two overlapping game tabs, counts the overlap twice. Document it or use the wall-clock union.
- M3. `tests/net/stats.test.ts:149` is titled "...and a rejected Pos" but never sends a rejected Pos. `pos_rejected` and the `acceptPos` rejection path are untested at the counter level.
- M4. The comment "(Whether the leave-time summary exists depends on the timer...)" in `tests/net/stats.test.ts` is misleading. The final summary is emitted synchronously in `finish`, right after `leave`, and the existing assertions already depend on it. `total("pos") === 2` can only hold if the final window was emitted, because the second move happens after the first periodic summary. So the weakened assertion does not hide a bug. Replace the comment with an assertion that `ev.at(-1)` is the `final: true` summary.
- M5. No test covers the replace path (same token in two game tabs). I traced it by reading:
  - `World.join` deletes the old member from `members` and closes the socket with 4000.
  - The old socket's `close` handler calls `finish(4000)`. `live.delete` succeeds, then `w.leave(conn)` finds no member and returns. So no spurious Leave is stamped.
  - The leave event and `play_ms` are counted once per connection. This is correct.
  - A test would pin it. A pre-existing quirk remains: the old tab can still `stamp` inputs under the same `playerId` between the replace and its actual close, because the `input` handler trusts `joined.playerId` and never checks `members.has(conn)`. This now also bumps stats. Guard with `if (!w.hasMember(conn)) return`.
- M6. `World.whoOf` builds `name#id`. `cleanName` may allow `#`, so a name like `a#5` logs as `a#5#7`. The id is always the last `#` segment, so parsing is still possible. Note it where the log format is documented.
- M7. `tests/net/names.test.ts` checks plain names only for game-world `S_PLAYER_NAME` and not for the sandbox. The sandbox path is guarded in `World.join` (`name` is empty unless the world is a game), so it is correct but untested.
- M8. In `names.test.ts` the `await sleep(10)` before closes does nothing. Remove it.

## Checked and fine

- **Identity and the sim.**
  - A sandbox sim id still comes from `nextPlayer++`. Game ids come only from `gamePlayer ? visitorId : undefined`.
  - A spectator, with or without a token, gets `spectate` set. So there is no replace, no Join and no Leave, even if its token matches an online player.
  - `visitorId` and `visitorName` are only read by `whoOf` and stats, never by `stamp`.
- **Payload offsets.**
  - Pos y is read at `getInt32(6)` over a payload of life u16 at 0, x at 2, y at 6. This matches `acceptPos` and `encodePos` (y at frame offset 11 minus 5).
  - Paint material is `payload[0]`, matching `encodePaint` (offset 5).
  - Cast spell is `payload[0]`, matching `encodeCast` (offset 5).
- **The `live` map.**
  - The entry is created synchronously after `join`, with no await, so a socket that closes before or during HELLO cannot leak one.
  - `finish` is idempotent through `live.delete`. `close()` finishes every session before `w.shutdown()`, so `play_ms` and leave events are emitted, and flushes before `db.close()`.
  - A member dropped by `World.dropped` (a slow peer, which is closed with 1013) gets its leave event when the socket closes, because the world's `leave` is a no-op the second time. For a send that throws without a close, the leave event lags until the socket dies.
- **PlayerStats.** `max` semantics are right across a restart, because totals load from the DB on first touch. `visitorId` 0 is ignored. Memory is bounded by at most 900 registered players.
- **Migration 4.** It is appended and the test applies it on top of a v3 database.
- **Logging.** No per-input event is logged without `limited` (`input.rejected`, `pos.rejected`, `input.rate_limited`). `input.summary` is one line per connection per 10 s, and only when it sent something.
- **Name leakage.** `S_PLAYER_NAME` and the labels use `name` only. No HTTP route exposes `log.recent`.
- **Timing in the new tests.** The assertions are tolerant of the periodic-timer phase, so I found no timing dependence.

## Resolution

- S1: names moved to `shared/names.ts`, the client imports them from there, `tests/net/imports.test.ts` guards server/ and shared/ against client imports (e46c83f). Docker was not running, so the image was not built; I booted `server/main.ts` from a copy holding only server/, shared/, README.md, the wasm and dist/client, and it started and served `/readme/`.
- N1: `joined_at` is stamped only for game-world players, and `evictUnjoined` deletes stats rows first, in one transaction (53791dc).
- N2, M1: failed flushes retry row by row and log through `log.limited` once a minute; `max_depth` is skipped when no Pos was sent (eca5df1).
- M3, M4, M5, M8: rejected-Pos test, final-summary assertion, replaced-tab guard (`hasMember`) with a test, no-op sleep removed (this series' code commit).
- M2 (overlapping `play_ms`) and M6 (`#` in names) are left as they are and noted in D-090 and D-091. M7 is untouched.
