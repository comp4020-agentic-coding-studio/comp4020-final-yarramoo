# Fix review 1-3 report

## Commit 1: room-load failure caught
- `server/main.ts`: `.catch` on the HELLO `getOrLoadRoom(...).then(...)` chain covers load and continuation. It resets
  `handshaking`, logs `hello.failed` through `log.limited` (keyed per room, 10 s), and rejects with "room unavailable; try again later".
  `getOrLoadRoom` only inserts into `worlds` after `load()` succeeds and clears `loadingRooms` in `finally`, so nothing stays half-registered.
- Boot-time refusal for the fixed worlds is kept (the `await w.load()` at start-up is untouched).
- Red first: with the fix stashed the test timed out (client never rejected) and vitest reported an Unhandled Rejection
  "world 2: could not verify the stored snapshot under the new build".
- Test: `tests/net/stability-fixes.test.ts` (room stored under an old build with a hung verifier).

## Commit 2: incident writes guarded, per-world tick isolation
- `server/world.ts`: `safeDb()` wraps `recordIncident` and both `updateIncident` calls; a throw logs `db.write_failed`
  (limited, per world) and the hash/resync path carries on.
- `server/main.ts`: the tick timer catches per world. `failWorld` logs `world.tick_failed` (limited), closes that world's sockets
  with 1011 (their close handler runs `finish`), then `World.shutdown()` (flush, `closing = true`). A closed world is skipped by the timer.
  A room is also deleted from `worlds` so the next HELLO reloads it; the two fixed worlds stay registered but closing
  (joins get "server is shutting down").
- Red first (fixes stashed): recordIncident test threw "disk full" out of `onHash`; tick test timed out waiting for `world.tick_failed`.
- Gate: determinism 53/53, net 325/325, cargo 0 failures, clippy clean.

## Commit 3: paint stroke bound
- `sim/src/tuning.rs`: `MAX_PAINT_STROKE = 128` (Chebyshev cells). `sim/src/sim.rs`: `paint_stamps(n) = min(n, 128)`; the loop keeps
  interpolating against the full `n`, so a long stroke is truncated from (x0, y0) along the same line.
- Worst case drops from 512 stamps (about 6.6 M writes) to 129 stamps (at most about 0.5 M writes).
- Limit reasoning: `client/worker.ts` sends one segment per 33 ms from the last sent point, so a segment is one send interval of pointer
  travel. 128 cells is at least 256 px in 33 ms (7,700 px/s) at the minimum zoom of 2 px per cell. This is reasoned, not measured: I did not
  record real drags. Only a stalled tab batching several intervals can exceed it.
- Truncate rather than drop: the visible paint where the stroke began survives, and the next segment starts at its own anchor. Dropping
  would punch a hole in an otherwise legitimate fast drag.
- Optional r/2 step not done: it changes every painted shape (determinism expectations) for a bound the length clamp already gives.
- Red first: with the clamp removed, `worst_case_input_stamps_are_bounded` failed ("512 stamps") and the truncation test failed;
  with the bound halved to 64 it failed ("129 stamps").
- No determinism expectation changed. CLAUDE.md paint bullet updated.
- Gate: cargo 339 passed, 0 failed, clippy clean, tsc clean, determinism 53/53, net 325/325.

## Architectural decisions for review
- Closing a failed world: `failWorld` closes its sockets (1011) and calls `World.shutdown()`, which sets `closing`; the timer skips closing worlds. Rooms
  are removed from `worlds` (reload on next HELLO). Fixed worlds 0/1 stay registered but closed until restart, so they refuse joins; a
  throwing sandbox tick therefore leaves a dead sandbox until the platform restarts the process. Alternative: let the fixed worlds retry.
  Chosen as the safe-and-reversible option.
- Truncate versus drop a long stroke: truncate (above).
- Boot-time refusal for fixed worlds is kept; only lazily loaded rooms reject the one client.
- Unverified: the paint limit against real drag data; `world.tick_failed` on a fixed world in a live deploy.
