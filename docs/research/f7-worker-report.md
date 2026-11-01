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

## Left (not done)
- Item 3: lobby stat gating from `roundRunning`; Spectate choice before join (client can already read `running`/`ended` from `GET /api/rooms/:code`). Toasts use the existing achievement toast path and plain names.
- Item 4: PLAYER_NAME after RESYNC, resync budget, liveness timeout, incident pruning.
- Item 5: log names `round.start`, `round.end`, `boss.killed`, `claim.round_start`, `claim.round_end`, `enemy.kill`, `resync.refused` are in `shared/events.ts` and `round.start/end`, `boss.killed` are emitted; `enemy.kill` aggregation, `claim.*` logging and dashboard round state are not.
- Items 6 and 7: no balance numbers, no browser descent.
- Unverified: client emission of the new claims in a real browser (typechecks only; no test client sends claim events yet).

## FUTURE.md suggestions
- Add the enemy id to EV_ENEMY_DEATH so kill claims need not key on position.
