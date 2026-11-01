# F7 worker report (Survival polish)

Status: partial. Items 1 and 2 done; 3 to 7 not reached (tool-call budget spent mostly waiting on the 8-minute gate). See "Left".

## Commits
1. Deaths in every room: `0270940`. Red first: `tests/net/claims-rooms.test.ts` timed out ("death counted in a created room") before `wireWorld()` existed; green after. Gate: cargo 339, determinism 53, net 326, all exit 0.
2. Generalised claims (kill, round start, round end): `2e8fbe4`. Gate: cargo 339, determinism 53, net all green (after updating the schema-version and achievement-list expectations, which this slice changes on purpose). Tests `tests/net/claims-events.test.ts` (12). Red-first caveat: the test file was written after the implementation, so the "red" is only that it could not compile or import before; the quorum behaviour was not shown red separately.

## Architectural decisions for review
- Claim format: new message `C_CLAIM_EVENT = 0x09` (`kind u8, tick u32, a, b, c, d u32, n u8, ids u32[n]`, n <= 32). `C_CLAIM` (death) is byte for byte unchanged, so the protocol version was NOT bumped. Alternative: a kind byte inside C_CLAIM (breaks deaths) or one message code per claim. Cost to Deathmatch: none.
- Enemy kill identity: EV_ENEMY_DEATH carries no enemy id (a = x, b = y, c = kind), so the claim key is tick plus position; rivals share that group. The brief's "enemy id" does not exist in the event.
- Claim machinery: `onClaim` refactored into `admitClaim` (rate, anon, tick window) + `vote` (dedup, dissent, tally) + `tryResolveClaim` keyed by a `group`; death behaviour unchanged (existing claims tests pass).
- "ended": persisted on the room row (`rooms.ended_at`, migration 7), so it survives restarts and keeps the room off the list. "running": memory only (`World.roundRunning`), exposed as `running`/`ended` on `GET /api/rooms/:code`. Cost: after a restart `running` is false until a new start claim, and no start claim can come for an already-running round, so the lobby gate (item 3, not built) must treat "ended or round already past start" carefully.
- Alive-at-win set: each client sends the sim's own alive set (player entities with health > 0) inside CLAIM_ROUND_END; it is part of the tally key, so a majority must agree on the exact set. Server refuses a win with an empty set and ids it never saw join. Alternative: server recomputes from death claims (rejected: loses the sim's rule). A 1-player room is its own majority.
- Achievements: onEnemyKill (slime_slayer, exterminator at 50 enemy_kills), onRoundWon (deep_mage_slain for every survivor, solo_descent when the sim holds 1 player, last_one_standing when exactly 1 survivor of a larger party).
- Spectate record, resync budget/close code, liveness timeout: not decided (not built).

## Second pass (items 1, 4, 3, 5 of the follow-up)
Committed together as one gated batch (the gate takes about 8 minutes; one run per batch, per the coordinator). Hashes in the handback.
- Real-client claim test: `tests/net/claims-survival.test.ts`. Two Node clients run the real sim in a size-S Survival room and ready up. `tests/net/helpers.ts` now sends the same `encodeClaimEvent` calls as `client/worker.ts`, built from the events its Node sim emits (the worker itself cannot run in Node). Asserts: `round.start` resolved and `roundRunning`; a real Fire bolt kills a slime and `enemy_kills` and `slime_slayer` arrive for the killer only; a scripted loss resolves `round.end` (result loss, alive 0), the room leaves `GET /api/rooms`, and `GET /api/rooms/:code` says ended. The boss kill was NOT driven (no deterministic input path sets boss hp); the win path is covered by unit tests of `onRoundEndClaim` and `onRoundWon` only.
- Helper bug found on the way: the test client only claimed when `sim.width() > 512`, which excludes size-S rooms; it now tests `cfg.avatars === 1`.
- Names after RESYNC: `World.resync` resends `PLAYER_NAME` for every named member. Red shown first (test failed with the line removed).
- Resync budget: 3 per member per 60 s (`RESYNC_BUDGET`); the 4th closes with code 4001 (`CLOSE_OUT_OF_SYNC`), logged `resync.refused`; the client shows "Out of sync, reload" and does not reconnect. The budget is per connection, so a reload (a fresh connection) starts fresh and an honest player is not locked out. `desync` and `resync` log through `log.limited`. Incidents are pruned to the newest 1000 on insert.
- Liveness timeout: any frame from a member refreshes `lastHeard` (`World.heard`, called from main.ts for every frame); a member that is live (past its replay) and silent 10 s is closed with 4002 (`CLOSE_SILENT`) and leaves through the normal path. A catching-up member is exempt, so a slow honest client mid catch-up is never dropped. Tested with an injected clock. The client pings every 2 s so an idle honest client is never silent.
- Lobby stat gating: `World.creditsStats()`; Pos depth and cast stats are not credited in a Survival room until the start claim resolves. Restart choice: a world loaded from the DB with closed ticks counts as credited (`restoredWithTicks`), since `roundRunning` is memory-only. Cost: a restored lobby with ticks is credited early; a restored running round is never wrongly denied. The claim lags the real start by up to a second, so that second is not credited.
- Spectate before the join: `resolveRoomTarget` reads `running`/`ended` from `GET /api/rooms/:code`; `start()` shows the late panel and returns without opening a socket, so no dead player record. The "Spectate" button reloads with `?spectate=1` as before, which joins as a pure spectator. Not exercised in a real browser (item 7 pass).
- `enemy.kill`: one line per room per summary interval (folded into the input.summary timer) with total and `by_kind`. `claim.kill`/`claim.round_*` names exist but are not emitted (the resolved events log as `round.*`, `boss.killed`, `enemy.kill`); the per-claim lines a client can repeat are the limited `claim.unresolved` and `input.rejected` ones. Admin dashboard world cards show `round` (lobby/running/ended); `/api/summary` carries only that aggregate state, no names.

## Left
- Items 6 (balance) and 7 (two-browser descent): third pass.
- Boss kill through a real-client test.

## Third pass, A: review fixes (`docs/research/review-f7.md`)
- S2: `onRoundStartClaim` refuses once running or ended; `onRoundEndClaim` refuses unless `roundActive()` (a start claim resolved, or a restored Survival room with ticks, and not ended). The `rs`/`re` markers are booleans, not entries in the `resolvedDeaths` FIFO. Test (red first, shown by reverting `world.ts`): a forged win after a loss and a flood of 1100 resolved kills resolves nothing.
- S3: `onKillClaim` refuses an enemy kind >= `NUM_ENEMY_KINDS` (new in `shared/sim.ts`, pinned against `sim/src/tuning.rs` by a test) and a position outside the room's size.
- S5: a loaded room takes `roundEnded` from `rooms.ended_at`; `running` in `GET /api/rooms/:code` and the admin summary is `roundActive()`, or for an unloaded room "Survival, has logged ticks, not ended". Tested with a real restart.
- S4: `tick()` forgives every member (`lastHeard = now`) and skips the sweep when the gap since the previous `tick()` exceeds 2 s. Tested with the injected clock.
- N1: an ended room refuses a non-spectator HELLO with "round is over; spectate or start a new room"; spectators still join. Chosen over "join as spectator" because it needs no new server role and the client's late panel already offers Spectate.
- Dead empty `if` for code 4002 in the client replaced by a comment.
- Existing claim tests that ended a never-started round now start it first (a precondition, no assertion weakened).
- Accepted risk (S1, per coordinator): one vote is a majority with 1 or 2 eligible voters, as for deaths since D-120. A cheater in a co-op room only cheats their own room, and requiring both voters in a 2-player room would let one player block the end. Room achievements are therefore not leaderboard material.
