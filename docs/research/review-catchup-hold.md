# Review: holding the clock while a joiner catches up

Scope: `git diff 1bb0379..91040d9` (D-122, protocol v7, `C_LIVE`). Read cold; no source changed.
Tests: `pnpm vitest run --config vitest.net.config.ts tests/net/catchup-hold.test.ts` ran 3 times: 8/8 passed each time (about 10.6 s).

Counts: S 0, N 2, M 3.

## N (should fix)

### N1. A hold concentrates up to 120 s of input into one tick (work amplification and a u16 overflow)
- `server/world.ts:650` (`stamp`), `server/clock.ts:93` (`stamp`), `shared/protocol.ts:296-300` (`encodeTick`), `server/main.ts:669` (rate limit).
- Inputs stamped while held all sit in the open tick N+1 and close together on release. The 40/s per-connection limit is meant to bound inputs per tick to about 1 per connection. A hold removes that bound. One non-live sandbox connection can send 40/s for 120 s, which is 4,800 Paints (r up to 32) in a single tick. Every client then executes all of them in one `step()`. Invariant "an input must not cost unbounded work" is stretched by about 4,800x per connection.
- `MAX_CONNS_PER_IP` is 12, so one IP can queue 57,600 inputs. `encodeTick` writes the input count with `setUint16(5, inputs.length)`. A second IP, or a longer `catchupHoldMaxMs`, pushes the count past 65,535 and it wraps silently. Clients would decode a corrupt TICK frame, and that frame is also persisted in the log. I did not probe this end to end; it is read from the code. The paint cost is estimated, not measured.
- The test `all close in the first tick after release` only covers 5 inputs.
- D-122 says "a hostile client costs at most this per connection". That is true for time but not for the burst it creates.
- Fix: do not stamp inputs from a member that is not live while the world is held, or cap them (for example 64 per member per hold). A replaying client has no legitimate input to send. If the Join-time Pos must go through, allow only the first few. Also assert `inputs.length <= 0xffff` in `encodeTick` or in `TickClock`.

### N2. `C_LIVE` is not tied to the current catch-up, so a stale LIVE can un-hold a replaying member
- `server/world.ts:746` (`onLive`), `shared/protocol.ts:341` (the `tick` field is decoded and ignored).
- A client that was live sends `C_LIVE`. The server then sends RESYNC and sets `live=false`. A `C_LIVE` already in flight, or any buffered one, arrives after the reset and marks the member live while it is still replaying. If that was the only member, the clock is released while it replays, which is the problem D-122 was written to fix. The window is small but real. With `tick` ignored, the server has no way to tell the old LIVE from the new one.
- Not a correctness break for lockstep (the clock only delays ticks), so N not S.
- Fix: in `onLive`, require `msg.tick >= m.minHashTick`. A genuine LIVE after replaying to the WELCOME or RESYNC tick satisfies that. The field is already on the wire and costs nothing to check. It also lets the server drop an early false claim, a bonus rather than a requirement.

## M (minor)

### M1. A backgrounded tab holds the world for up to 120 s
- `client/worker.ts:674-682`. LIVE is sent from inside `frame()`, which runs under rAF. If the tab or worker is hidden, replay and LIVE stall. When that member is the only one in the world, the world is held until the valve opens (120 s). Before the change the world kept ticking and the log kept growing. Probably acceptable, since nobody is playing, but it should be mentioned in D-122's cost column. Check that `frame` is also driven when the tab is hidden.

### M2. A world's periodic work stops while held
- `server/world.ts:660-661`. `tick()` returns once `clock.isPaused`, which skips `flush`, `resolveDue` (the `HASH_WAIT_MS` timeout), `sweepClaims`, `maybeRequestSnapshot` and `checkLogLength`. That is fine for a held lone joiner. When a hold starts because the last live player left (or a lone live player resyncs), those timers resume only on release. Nothing outstanding is lost, because the resync-pending checkpoints belong to the paused tick range. Still, `flush` is skipped for up to 120 s with `pending` ticks in memory. Crash exposure is small (those ticks are the old ones). Mentioned for completeness.

### M3. The only-live member resyncing holds its own world (D-122 does match)
- `server/world.ts:834-850`. The lone live player who resyncs (desync) is held while it replays. That matches the D-122 text ("a player who is live is never held by a *joiner*"; a resync is the player's own catch-up). The test `a resync of the only member holds the clock` pins it. It is consistent. One residual: a hostile lone client can alternate bad HASH and `C_LIVE` to keep re-arming a fresh 120 s hold for itself, since `catchupSince` resets on each resync. That only freezes its own empty-of-others world; with any other live member there is no hold.

## Checked and found fine
- **Clock arithmetic.** `resume()` rebases `t0 = now` and `baseTick = closed`, so releasing a hold never produces a burst; the first tick closes one tick-interval after release. `pause()` calls `advance()` first, so ticks owed up to the pause instant close in order. `release` calls `resume()` then `advance()`, which closes nothing extra.
- **Input order and tick filing.** Inputs stamped while held are filed at `closed + 1`, which is the tick number the client was told in WELCOME plus one. They close together in arrival order on release (the test checks the order Join, then 4 Paints). Nothing is dropped or duplicated. Reset clears `open`, and the last leave uses `pause(); closeNow()`, so the open tick is flushed on empty-world exit.
- **Safety valve.** `limit = heldSince + holdMaxMs` once held, so reconnects during a hold cannot extend it. After expiry the old non-live members have past deadlines, so they do not re-hold. A new join sets a fresh `catchupSince` and starts another hold, at most once per join, and only when no member is live. It cannot be chained inside a hold. So the worst case is repeated joins by an attacker against a world with no live player.
- **Freezing a live player.** A joiner never holds a world that has a live member (`join` only skips `resume()` when none is live, and `evaluateHold` sees `anyLive`). A resync of one member with another live member does not hold (tested). A replaced socket (code 4000): the old member is deleted, the new one starts non-live, and the world is held only if no one else is live (a lone reload re-replays, so correct). The old socket's later `finish()` calls `leave` as a no-op. The only live member leaving while a joiner replays pauses the clock, and the joiner's LIVE releases it. A whole-room desync holds until the first member reports live. A sandbox and game world each have their own `World` and `TickClock`, with no cross-talk.
- **Snapshot selection.** `requestSnapshot` still uses `lastHashTick`/`minHashTick`, not `live`. A claimed-live client with no HASH is never asked for a snapshot. `onHash` sets `live` only for HASH ticks above `minHashTick`, which a held clock cannot produce.
- **Dropped-peer drain.** `tick()` and `onClosed` both `shift()` from the same array and `leave` is a no-op for a removed member, so a Leave is stamped once. `join` and `resync` push to `dropped` after the member exists. A Leave stamped during a hold waits in the open tick and closes in order.
- **Client playout.** While held there are no TICK frames. `Lockstep.plan` returns 0 at an empty buffer and rebuffers to J before resuming, so the client pauses and recovers on release.
- **Tests.** The 8 tests use `sleep`/`waitFor` only for negative assertions ("the clock did not advance in 200-1500 ms") and for polling with 3-60 s ceilings. A negative assertion that passes by sleeping cannot flake in the passing direction. The positive waits are bounded polls, not fixed sleeps. The valve test has a lower bound of 450 ms against a 500 ms valve (it measures from before the connect), and an upper bound of 2000 ms, so it is not tight. The tests would fail if the hold, the release on LIVE, the valve or the ordering broke. They would not catch N1 (no large-input test) or N2 (no stale-LIVE test).
- **Tree.** `git status` showed only the pre-existing `.gitignore`, `README.md` and `docs/DECISIONS.md` changes plus this file.

## Resolution (fixed by the orchestrating session)

- **N1 fixed, at the cause and with two backstops.** `World.stampClient` drops a client's Pos, Cast and Paint while the world is held (only replaying members exist then, and they send no play, so nothing a person did is lost) and caps client inputs at `MAX_CLIENT_INPUTS_PER_TICK` (4096) per open tick. Join and Leave are the server's and stay uncapped through `stamp`. `encodeTick` now throws a `RangeError` for more than 65535 inputs instead of writing a wrapped u16 count. Tests: inputs while held are dropped (logged `input.rejected` reason `world_held`); the cap; the encoder refusal. Each failed on `91040d9`, the encoder test with "expected function to throw an error, but it didn't", which is the wrapped-count bug itself. The earlier test that expected held inputs to wait and close on release encoded the old behaviour and was rewritten.
- **N2 fixed:** `onLive(conn, tick)` ignores a LIVE whose tick is **below** the member's `minHashTick`. The first attempt used "at or below" and broke every real LIVE, since a client's LIVE names exactly its replay target, which equals `minHashTick`; seven tests caught it before anything was committed. The resync test was updated: its never-stepped client sends a stale LIVE, which is now correctly ignored.
- **M1–M3** left: a hidden tab's 120 s hold is the designed valve; M2 (no flush or sweeps while held) costs nothing, as nothing is ticking; M3 matches D-122.
