# Review: M6 slice b (majority-claimed achievements)

Diff `59fd57b..a972801`. Read cold; no source changed. Live test run 3 times: 3/3 green (19 tests in the two files each run).

## S: must fix before pushing

### S1. Anonymous spectators are voters, so a Sybil of sockets forges any death, kill or achievement for any visitor id
`server/world.ts:791-803` (`eligibleAt`, `liveVotes`), `server/main.ts:575-583` (a spectator needs no token and gets `visitorId 0`), `server/main.ts:54` (12 sockets per IP, 64 members per world).

`eligibleAt` counts every member, spectators included, and `liveVotes` counts any member's vote. A spectator costs nothing: no registration, no rate limit beyond 12 per IP. Quorum is `ceil(eligible/2)` and a key wins when `votes >= need` and `rival < votes`. With `h` honest members and `k` attacker spectators, `k >= h` reaches quorum. The claim is for a tick and victim no honest client ever reported, so there is no rival and it wins at once.
- 8 players, 8 spectator sockets (one IP allows 12): any visitor id can be given `first_blood`, `five_kills` or `back_from_the_dead` (10 forged deaths), plus `shoved_to_doom`.
- 3 players: 3 sockets are enough.
- The killer and victim ids are never checked against world members (see N1), so the target need not be playing.

Evidence: `tests/net/claims-live.test.ts` "a spectator's claim counts as a witness" already proves the 2-member case. One spectator alone resolves a death for Ana, who never died.

Fix, cheapest first:
1. Only members with `playerId != 0` (registered game players) count as eligible and as voters. Spectators then cannot vote. This costs the "phone spectator is a fair witness" idea (D-118).
2. Also require victim and killer to be current members' `playerId`, or the id of a member that was present within the window.
3. Optionally require `votes >= 2` once `eligible >= 3`.

Option 1 plus the N1 check removes the zero-cost path. Registered sockpuppets remain (see the 2-client section).

## N: should fix

### N1. Victim and killer ids are not validated against the world
`server/world.ts:757-788`, `server/achievements.ts:56-68`.

A claim carries any `u32`. Once it resolves, `PlayerStats.bump` and `Achievements.grant` run for that id.
- If the id is a real, registered player who is not in the world (or is offline), they are awarded the stat or achievement. A lone player (1-member world, majority = 1) can do this alone, 3 forged deaths per second.
- If the id is not a player, `totals`/`dirty` and the achievements `have` cache grow without bound, and `player_stats.player_id references players(id)` with `foreign_keys = ON` (`server/db.ts:110`) means the upsert should fail. `flush` (`server/stats.ts:69-80`) then retries row by row on every flush and keeps those rows dirty forever. I did not run this probe; it follows from the quoted code.

Fix: in `onClaim`, require `victim` to be a member `playerId` (or `0` is invalid for victim), and `killer` to be `0` or a member `playerId`. Reject otherwise as `input.rejected` reason `claim_unknown_player`. Add a test.

### N2. `claim.death` is logged with `log.event`, not `log.limited`
`server/main.ts:239-243`.

CLAUDE.md says anything a client can trigger repeatedly goes through `log.limited`. A lone client (or the S1 Sybil) triggers one unlimited line per forged death, 3 per second per connection, and floods the ring the admin dashboard reads. Fix: `log.limited("claim_death", ...)` with a per-kind window, or keep a count in `input.summary`. Note that `limited` suppresses the lines the `claims-live` test reads; the test needs a first-occurrence read (the first occurrence always logs, so it would still pass).

### N3. Open-tally eviction lets a flood suppress real deaths; the sweep is O(n^2) every 4 ms
`server/world.ts:781-785`, `832-841`, `server/main.ts:55` (`TIMER_MS = 4`).

- The rate limit is per connection. 12 sockets per IP is 36 distinct-key claims per second. The 256-tally cap fills in about 7 s, and tallies live 10 s. The oldest tally is evicted silently, which drops votes already received for a real death. A later honest vote re-creates the tally with only its own vote. Suppression needs sustained flooding and a slow quorum, so it is plausible but not cheap.
- `sweepClaims` runs every timer tick. For each of up to 256 tallies, `tryResolveClaim` calls `eligibleAt` (O(members)) and loops all tallies for rivals (O(tallies)). That is about 256 x 350 = 90k operations per 4 ms tick (about 22M per second) under a flood. Fix: sweep at most every 250 ms, and index rivals by `tick:victim`.
- Eviction has no log line.

Resolving N1 and S1 removes most of the incentive, since forged keys for non-members would be refused before they make a tally.

### N4. The quorum-shrinks-on-leave rule (D-119) and resync have no resolving test
`tests/net/claims.test.ts:116` only checks that a leaver's vote does not resolve. Nothing checks the case D-119 describes: 3 eligible, one votes, one leaves, quorum drops to 1, and the sweep resolves. `sweepClaims -> tryResolveClaim` is the only path for that and it is untested. There is also no resync test (`minHashTick` moving after the vote).

## M: minor

- **M1, redundant eligibility checks are not individually tested.** `world.ts:771` (`d.tick <= m.minHashTick`, at the entry) and `world.ts:802` (`liveVotes` filter) overlap for a late joiner, which is why the test fails only when both are removed. They are not dead code. The `liveVotes` filter is the only guard when a voter resyncs after voting, since `minHashTick` rises at `world.ts:743`. The entry check is the only guard against a late joiner creating a tally. Neither is exercised alone. Add one test per rule (a resync after voting, and a late joiner's claim refused).
- **M2, `shoved_to_doom` rule matches its description, and a self-kill or an uncredited death cannot earn it.** `server/achievements.ts:62-67` requires `killer != 0 && killer != victim`. The cause list `[6, 7, 8]` is hard-coded in `shared/achievements.ts:40` rather than importing `CAUSE_FIRE/LAVA/GUNPOWDER` from `shared/sim.ts`. If the sim renumbers a cause, the two drift silently. Import the constants or add a test asserting equality.
- **M3, per-connection rate window resets on reconnect.** `claimWindowStart` and `claimsInWindow` live on the member (`world.ts:492`), so a reconnect gives another 30 claims. It is cleaned up with the member, so there is no leak. Connection churn is limited elsewhere, so this is low risk.
- **M4, `claims-live` first test is wall-clock dependent.** It uses `sleep(500)`, `sleep(700)`, and up to 12 casts in a loop. It tolerates slow runs, since it is a retry until the death appears. It also assumes Ana never dies to her own bomb first and that `ev` has length 1. It passed 3/3, but it depends on real-time lockstep. Consider also asserting `ev[0].victim` before the other checks, so a self-death gives a readable failure.
- **M5, stalled members raise the bar.** A backgrounded tab that does not claim still counts as eligible, so the quorum is `ceil(eligible/2)` of everyone. If half the members stall, deaths go unresolved (logged as `claim.unresolved`). Acceptable, and recorded here for the user.

## 2-client trust limit (design question for the user, not a code bug)

With 2 eligible members the quorum is `ceil(2/2) = 1`, so the first claim wins and the other client's claim is only logged as `dissent` (`world.ts:777-778`). A lone liar among two honest-looking clients cannot be told from an honest one. With 1 member the server trusts that client, as D-045 already does.

Worse variants of the same limit:
- A spectator is one of the two members, so a spectator plus one player is a 2-member world where the spectator alone decides (this is what the live test demonstrates).
- Two registered visitors controlled by one person are not a Sybil the code can see. In a 3-player world, 2 of them are a majority; in a world of `n` players, `ceil(n/2)` puppets are. Registration is rate-limited (`MAX_CREATES_PER_MINUTE`) but not scarce.
- A client that claims first wins whenever it alone meets quorum, which is only at `eligible <= 2`.

Options for the user: (a) accept it and say so in the deliverable, since achievements are cosmetic; (b) require at least 2 votes whenever 2 or more players are present, so a 2-member world needs both; (c) have the server derive truth some other way. (c) is ruled out by invariant 11.

## Checked and found fine

- **Decoder:** fixed length 15, anything else returns `null`; `getUint32` on a view of the exact length cannot throw (`shared/protocol.ts:328-330`). The fuzz test in `protocol.test.ts` covers it.
- **Invariant 9:** the client only reads `sim.events()` and calls `ws.send` (`client/worker.ts:224-229`). Nothing from a claim reaches `stamp()` or `push_input`. Server-side, `onClaim` writes stats and achievements only, never the clock or sim.
- **Invariant 11:** the server does not step the sim; the tally is pure bookkeeping.
- **Duplicate counting:**
  - The vote set is keyed by connection id, so repeats count once.
  - After a tally resolves, `resolvedDeaths` (keyed `tick:victim`) blocks any other key, including keys that differ only in `bag`, and logs `dissent`.
  - A claim after eviction is refused by the 600-tick window before `resolvedDeaths` could have evicted, unless more than 1024 deaths resolve in 10 s.
  - A reconnecting client does not re-claim during replay: the client gates on `tick > catchUpTarget` and the server on `tick > minHashTick`. These match, because `minHashTick` is set to `lastClosed` at join (`world.ts:490`) and the welcome carries the same value.
- **Rival logic:** a tie waits and times out; a strictly larger group wins; losers are deleted and logged.
- **Maps bounded:** `claims` 256, `resolvedDeaths` 1024, `claims` and `resolvedDeaths` cleared on world reset (`world.ts:652-653`). The rate state is on the member and dies with it.
- **Self-kill:** `killer == victim` bumps deaths only (`achievements.ts:57`).
- **Sandbox:** refused with `badInput`, which is `log.limited`.
- **Worker redundancy:** the `!ls.fastForwarding` condition (`worker.ts:224`) is implied by the new `tick > ls.catchUpTarget` check, so it is harmless.
- **Live test:** 3 runs of `claims.test.ts` and `claims-live.test.ts`, all 19 tests passing each time.


## Resolution

- **S1** fixed in `accef4f`: only registered visitors vote or count toward the quorum, per distinct visitor; anonymous claims are refused and logged with `log.limited`.
- **N1** fixed in `8e61cb1`: a death may only name players this world has seen join (a set filled from Joins, cleared on reset); an unknown victim is refused and an unknown killer is credited to nobody.
- **N2** fixed in `c0985d9`: `claim.death` goes through `log.limited` (one a second); the other per-claim lines already did.
- **N3** fixed in `c0985d9`: the sweep runs every 250 ms instead of every 4 ms tick (measured 0.076 ms per sweep at 64 members and 240 tallies, now run about 60 times less often); eviction is still unlogged.
- **N4** fixed in `c0985d9`: tests for a claim resolving after a voter leaves and for a voter that resyncs after voting.
- **M1** the resync-after-voting test now exercises the `liveVotes` guard on its own; the entry check is covered by the late-joiner test.
- **M2** not changed: the cause list stays hard-coded; recorded as a drift risk.
- **M3** not changed: reconnecting resets the per-connection claim window; churn is limited elsewhere.
- **M4** not changed: the live test is wall-clock dependent but retries until the death appears.
- **M5** accepted: stalled members raise the bar and unresolved deaths are logged.
