# Review: crit 10 slice 5 (admin reset)

Scope: `git diff b24cfc6..0de4f77`. Method: read the diff and the whole `World`, `TickClock`, `main.ts` message path and `client/worker.ts` reconnect path. Ran `tests/net/reset.test.ts` twice (10/10 passed both times). No source changed.

Result: 0 S, 2 N, 6 M. No must-fix defect found.

## S (must fix)

None.

## N (should fix)

### N1. `admin.refused` is logged unthrottled, so an unauthenticated client can flush the event ring and flood admin streams
`server/main.ts` `adminReset`, the `refuse` helper:
```ts
log.event("admin.refused", { action: "reset", reason, status, ip_tag: ipTag }, "warn");
```
Scenario: anyone who can reach the server POSTs `/api/admin/reset` in a loop with no token. Each request writes a warn event, which is pushed into the `recent()` backlog and out to every open admin SSE stream. Real events (desyncs, `world.reset` itself) get evicted from the backlog. The neighbouring code uses `log.limited(...)` for exactly this (`register.refused` at the ws-per-ip cap, `main.ts` ~387).
Fix: `log.limited(\`admin:${ipTag}\`, 10_000, "admin.refused", ...)`. The reset test counts exactly 3 refusals from 3 requests, so give the test distinct reasons or an injectable interval. Better: key the limiter by `ipTag+reason`.

### N2. Dashboard ticks/s goes negative or garbage for up to 10 s after a reset
`server/main.ts` `sampleTicks` / `summary`: `ticksPerSec = (w.clock.lastClosed - first.tick) * 10000 / dt`, where `first` is a sample from before the reset. After a reset `lastClosed` is 0 (or small), so the value is large and negative until the 10.5 s window rolls. It is display only, but the admin who just pressed Reset sees a broken readout on the very page they pressed it on, and it may trip a "ticks/s" alert.
Fix: clear `tickSamples` for that world after `w.reset()` in `adminReset` (a `tickSamples.delete(w.id)` is enough, since `sampleTicks` re-creates it), or clamp at 0.

## M (minor)

### M1. The `resetting` guard is unreachable
`World.reset` is synchronous start to finish. `ws.close` does not call back synchronously, so no code can observe `resetting === true` (`stamp`, `join`, `onHash`, `onUpload` guards never fire). `join` throwing "world is resetting" would be an uncaught exception in the ws message handler if it ever did fire, and the client would see a bare socket drop instead of a clean refusal. Harmless today. Suggest deleting the flag, or keeping only the re-entrancy check and adding a comment, so a future async step doesn't inherit a half-working guard. If an `await` is ever added to `reset`, `join` should return a REJECT-free retryable close (e.g. `ws.close(1013)`) because a REJECT stops client reconnection.

### M2. `nextPlayer` is not persisted by the reset
`db.resetWorld` leaves `worlds.next_player` as it was at the last flush. `nextPlayer` is only written in `flush()` when `pending` is non-empty. Scenario: sandbox in-memory counter is 9, DB says 7 (last flush before two joins); reset; process crashes or restarts before the next flush; the sandbox then re-issues 7 and 8. Not a state-safety bug (the log was discarded), but D-097 states "ids never repeat". Fix: call `this.db.setNextPlayer(this.id, this.nextPlayer)` in the same transaction as `resetWorld`, or immediately after a successful one.
Checked and fine: cold start after reset restores `last_tick = 0`, no snapshot, empty log, and `next_player` from the row (test "persists" covers it).

### M3. `?token=` is accepted on the POST
`dashboard.ts` `isAdmin` falls back to the query string when the Authorization header is not `Bearer`. For a state-changing POST that puts the token in URLs, proxy logs and Referer headers, and the dashboard page already sends the header. Not CSRF-able (an attacker needs the token, and cross-site fetches and form posts carry an `Origin` header that `originOk` rejects, including `Origin: null`). Suggest the reset endpoint require the header only.

### M4. 413 path destroys the socket after writing the response
`adminReset`: `refuse(413...)` followed by `req.destroy()`. The 413 body is usually never delivered, so the client sees ECONNRESET. The test accepts `r === null || 413`, so it cannot tell. Prefer `res.setHeader("connection","close")`, send the response, and let the socket close; or keep it and say so.

### M5. Reset deletes data beyond the log and snapshots, silently
`resetWorld` deletes all `snapshots` rows for the world, including any with `keep_for_timelapse = 1`. Nothing sets that flag yet (grep: only the schema and the insert), so no loss today. `desync_incidents` rows for the world are kept and now refer to tick numbers from the old numbering. Both are worth a line in D-097, and a decision before timelapse snapshots are implemented.

### M6. Test timing assumptions (not found flaky, but fragile)
- `reset.test.ts` test 1 builds `replayLog(s.world, ...)` from `s.world.log` ~2.4 s after the post-reset join. This is only valid while no snapshot has been accepted (an accepted snapshot splices `log` and sets `logBase`, so the replay would start from the wrong state). With `snapshotEveryTicks: 120` the first snapshot lands near tick 240 (about 4 s), so the margin is about 1.6 s. A slow CI machine stretching `paintFor` or the hash wait could eat it. Make `replayLog` assert `w.logBase === 0`, or pass `snapshotEveryTicks` large in that test (it does not need snapshots).
- The same test asserts `solidCells(c) === freshCells` after c has fast-forwarded some ticks. It holds only while the generated sandbox conserves non-empty cells under stepping; compare against a fresh sim stepped the same number of ticks instead, or against `ref.at` hashes.
- I could not reproduce the one-off net-suite failure in two isolated runs of this file (it needs the whole suite's contention). If it was in this file, the two assertions above are the likeliest places: both depend on wall-clock margins rather than on events.
- Test "unaffected world" asserts `s.game.log.length > gLog` after 300 ms; it would break if a game snapshot spliced the log in that window (not at the 1800-tick default; safe).

## Checked and fine

- **State not cleared that should be:** compared every `World` field with `reset`. `seed`, `kind`, `closing`, `nextPlayer`, `nextSeq` are meant to survive. Everything else is reset: `log`, `logBase`, `snapshot`, `snapFrame`, `dropped`, `online`, `snapshotOnline`, `onlineAt`, `pending`, `pendingFirst`, `lastFlush`, `checkpoints`, `truth`, `request`, `waitingUpload`, `verifying`, `lastRequestTick`, `lastPosOf`, `stats`. No timers live inside `World` (the single server interval calls `tick()`), so there is nothing pending to cancel. The clock is paused, so no tick closes until the next join re-bases it.
- **tick_log collision:** the DB reset and clearing `pending` happen in one synchronous run with no `flush()` in between, so no old-numbered batch can be written afterwards and a new tick 1 cannot hit a stale `(world_id, first_tick)`. A DB failure leaves memory untouched and `resetting` is cleared in `finally`.
- **In-flight verification:** the `gen` guard covers both `.then` and `.catch`, and `verifying` is not clobbered by the stale branch. The test would fail without the guard (without it `saveSnapshot` runs).
- **Sockets closed with 4001:** members are removed before closing, so `finish`'s `w.leave` is a no-op. Every message path after join is behind `if (!w.hasMember(joined.conn)) return;` (`main.ts` ~609), which covers input, hash and snapshot-upload. Connection ids come from the never-reset `nextSeq`, so an old connection cannot alias a new member. A socket that never answers the close frame lingers harmlessly (ignored messages). `peer.close` errors are swallowed; if it ever threw, the member would be a zombie (open socket, no ticks), but `ws.close` on an open socket does not throw.
- **Reconnect timing:** the client reconnects after 500 ms on any code except 4000, and `join` cannot be refused while `resetting` (see M1). No REJECT is produced by the reset path.
- **Other world:** reset touches only `this`; the DB statements are keyed by `world_id`. Test covers it.
- **Endpoint security:** origin check, then `isAdmin` (timing-safe digest compare, reused), then body parsing with a 1 KB cap; an unauthenticated request gets only 403 (no world existence, no `oldTick`). The 405 for GET reveals only that the route exists. No cookie auth exists, so classic CSRF does not apply.
- **Dashboard:** the token goes to a relative URL (same origin); results are written with `textContent`; `j.error` is only shown from the admin's own 500 response.

## Resolution (fixed by the orchestrating session)

- **N1** fixed: `admin.refused` goes through `log.limited` keyed by address (10 s); the 403 test now sends 20 bad POSTs and expects one event.
- **N2** fixed: a reset clears that world's tick samples. Measured without the fix: ticks/s read 6.8, 12.6, 17.1 for the seconds after a reset (true rate ~60). The new test asserts > 40 and fails without the fix.
- **M2** fixed: `World.reset` persists `next_player` alongside `resetWorld`.
- **M3** fixed: the reset POST accepts the token only as a `Bearer` header, not `?token=`; tested.
- **M6** (the `replayLog` margin) guarded: `replayLog` now throws if the log no longer starts at tick 1, and the sandbox reset test boots with snapshots out of reach. This is the most plausible cause of the one unexplained suite failure, but three runs with the old cadence did not trigger the guard, so it is not proven.
- **M1, M4, M5** left as they are: the `resetting` guard is harmless defence; a lost 413 body is acceptable; there is no timelapse feature and old `desync_incidents` rows are history, not state.
