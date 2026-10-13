# M4b review (origin/multa..HEAD), read-only

## Verdict: the sim side (projectiles, trig, bursts, snapshot) traces as sound and lockstep-safe. The one real problem is the D-073 respawn rule, which turns the server's Pos limit into a two-message free teleport. A stale-Knock gap and a rate-limit miscount are smaller should-fixes.

CONFIRMED means the code path was traced; SUSPECTED means it was not.

## Should-fix

### S1: D-073 lets any client teleport anywhere in two Pos inputs (shared/avatar.ts:48-52, server/world.ts:446-448)
CONFIRMED. D-073 and the `posAllowed` doc say a claimed `life + 1` is harmless because "the sim drops that Pos, so nothing moves". That is true for the first message only. The server then stores the claimed `life` and the far x, y as the baseline.
Scenario, with real life L and baseline at A:
1. Send Pos(life = L+1, x = FAR). `last.life + 1 == L+1`, so it is accepted with no distance check. The sim drops it (`p.life != life`). The baseline becomes {FAR, life L+1}.
2. Send Pos(life = L, x = FAR). `last.life + 1 = L+2 != L`, so the distance check runs against the baseline just stored. It passes (distance 0). The sim accepts it (`p.life == L`) and sets `p.x = FAR`.
The player is now anywhere in the world, with the cave walls ignored. Before D-073 the same attacker was held to about 144 cells/s. This is a regression against plan 7.6. A client can also send life+1, life+2, ... repeatedly, and every one is accepted and logged.
Smallest fix that closes it for M4b: on a `life + 1` skip, do not adopt the claimed position as the baseline for the old life. Keep a separate `pendingLife` baseline, and accept a later Pos only for the life the sim is known to hold. The server cannot know that, so the stronger fix is to make the sim enforce the limit itself:
- Add `last_pos_tick` and a `respawn_pending` flag to `Player`, and include both in `write()` so they are hashed.
- The sim ignores a Pos whose jump exceeds `maxPosJump(dt)` unless `respawn_pending` is set. `respawn_player` sets the flag, and the first accepted Pos clears it.
Cheaper interim: allow the life+1 skip at most once per N ticks (for example 600) per player.
Until one of these lands, D-073's "Cost" paragraph is wrong and should be corrected.

### S2: a stale Knock is applied after a stall (client/worker.ts:200-206, client/lockstep.ts:35-36)
CONFIRMED trace, impact SUSPECTED.
The guard is `!ls.fastForwarding`, which only covers the initial replay (`tick < catchUpTarget`). After a hidden tab, a GC pause or a socket stall, the buffer is large. `ls.run(plan)` then steps many ticks in one frame, and each Knock event in them calls `avatar.knock` immediately with no avatar steps between.
Scenario: the tab is backgrounded for 5 s while a firefight happens. On return, every Knock aimed at me from those 300 ticks is applied in one frame. The velocity saturates at the cap (about 9 cells per tick) in the sum direction, so I am fired across the map by hits I never saw.
Fix: only apply a Knock when the tick is near the live edge, for example `tick >= ls.latestClosed - 6` (or `ls.buffered <= J + 4`). Skip older ones.

### S3: the cast throttle is not under the server rate limit (client/worker.ts:~520 `onCast`, server/main.ts:32)
CONFIRMED arithmetic.
The comment says "under 40 inputs/s even with Pos and a held button". But Pos is sent every 2 ticks (30/s while moving), and a cast every 90 ms is 11.1/s. That is 41/s against `MAX_INPUTS_PER_SEC = 40`. The excess is dropped silently, and it may be the Cast (the ghost then lingers 600 ms), or a Pos.
Fix: throttle to 120 ms or more (8/s gives 38/s), or send Pos every 3 ticks while casting.

### S4: `entity-layout.test.ts` does not cover projectiles (tests/net/entity-layout.test.ts)
CONFIRMED. The parser (`activePlayersIn`, server/world.ts:647-661) is correct: it reads the player section first, with 65-byte records and the id and active byte at +0 and +4. The projectile block is appended after pickups, so it cannot shift those offsets. But the test only joins and leaves players, and D-074's claim "unaffected" is not pinned.
Fix: add a Cast (Push and Water) to the test, step once so a bolt is in flight, and assert `activePlayersIn` still equals the truth. One line of setup.

## Notes

### N1: sound areas, one line each
- Projectile state: every field that affects a step (owner, spell, seq, x, y, vx, vy, age) is in `Projectile::write` (entities.rs) and so in `entity_bytes()`. Charges and cooldowns are in `Player::write`. Nothing else feeds a step.
- Order: bolts are pushed in input order and removed with `retain` after a per-bolt `gone` vector, so survivors keep spawn order. `mem::take` plus `step_projectile`/`impact` never touch `self.projectiles`, so the cast path cannot reorder mid-update.
- Integer-only: no f32/f64, no `usize` reaches state or bytes (`usize::from(spell)` only indexes const tables). Arithmetic is `>>` on i32 (arithmetic shift, floor) and `/` (toward zero), both deterministic. Magnitudes are small (`c * v <= 2.1e7`, `vx * k <= 16384`).
- DDA: at most 8 sub-steps, with speed clamped to 8 cells per tick, so the work is bounded. Player hitboxes are computed once per tick before any bolt moves, and a hit checks players in id order, so the result does not depend on the client.
- Caps: `MAX_PROJECTILES` 256 in total, 12 per player, age 180. A rejection costs no charge or cooldown. Only Blast skips the projectile cap, and it spawns nothing. Event count per tick is bounded by the inputs per tick, and the client queue is capped at 300.
- Snapshot D5 (sim/tests/spells.rs:277-343): casts at ticks 14, 21 and 28 sit right at the cuts, so bolts are in flight at the snapshot tick. The test asserts `r.projectiles == s.projectiles`, the hash, and the continuation hashes for 7 cuts. It does not assert that `s.projectiles` is non-empty at each cut (the global `in_flight >= 2` is the only check). Cheap hardening: `assert!(!s.projectiles.is_empty())` for the cuts 14, 21, 27, 28, 63.
- `decode` is hostile-safe: `np` and the projectile count are range-checked in u64, `fixed` is bounded by `b.len()` before the tail slice, and the count is checked twice. Overflow in a decoded projectile (x near i32::MAX, or age 65535) could only wrap in release. It cannot be reached, because a snapshot must hash equal to the honest majority state.
- Trig: table checked in, generated by `tools/gen-trig.ts`; `grep` finds no `sin`, `cos` or float in sim/. `angle >> 6` gives 0..1023, and index 1023 maps cos to `SIN[255]`, which is fine at the wrap. The axes are exact (angle 0 gives cos 16384; 16384 gives sin 16384, cos 0).
- Knockback double-apply: `stepOne` runs once per tick and `Lockstep.push` throws on a gap, so a tick is never applied twice. `beginReplay` makes a new `ls` with `avatar = null`, and `avatarReady` gates `knock`, so replay, resync, reconnect and late joiner do not apply old Knocks (only the target tick itself is live, and the avatar does not exist yet). Application is `e.player === myId`, so a client cannot knock another player (and ignoring a Knock only hurts that client).
- Knock cap is consistent: the cap is `(48 + 96)/16 - 0.01 = 8.99` cells per tick per axis, which is 143.8 units, against the server limit of `144 * (dt + 10)` per axis between Pos inputs two ticks apart. An honest knocked Pos is never rejected. The server cap needs no knowledge of the knock. Invariant 9: the only render-to-input path is Knock to avatar velocity to Pos, which plan 6.7 allows.
- Bursts: `grid.set` calls `touch`, which sets `dirty_since_hash`, `pristine = false`, `awake` and wakes neighbouring chunks, so a burst into a sleeping chunk wakes it (invariant 8). Cells written only into `EMPTY`. The fill order is fixed (`k` loop 0..12, `dx` -6..6). Seed placement uses the keyed `rng(seed, tick, at, k)`, and two bursts on one cell in one tick are deterministic.
- Aim: `quantiseAngle` rounds to u16 in main.ts (`castNow`) before the message is sent, and the worker masks again. Render-only state (poses, particles, ghosts, `playerView` for the ghost decision) never feeds an input except through the `ready` check, which only decides whether to draw a ghost; the Cast input is sent regardless.
- Ghosts: removed by matching `cast_seq` on an own `ENT_PROJECTILE`, on `EV_CAST` or `EV_CAST_REJECTED`, and capped at 600 ms. A rejected or dropped cast therefore cannot leave one stuck. A cast from an inactive or unknown player produces no event, and the 600 ms timeout covers it.
- Snapshot format (item 8): `main` has `FORMAT_VERSION = 1`, a sandbox only, and `server/main.ts` there rejects `worldId != 0`. CI deploys only from `refs/heads/main`. So no v2 or game snapshot has been deployed, and D-074 is accurate today. Local M4a dev DBs hit `World.loadFromDb`, which resets when the snapshot cannot be restored. The v1 path is untouched: `entity_bytes()` is empty for `world_kind 0`, `Cast` is dropped by the sandbox guard, and restore keeps its `version == 1 || kind == 0` branch. Caveat: this holds only while multa is not merged and deployed with a live game DB. After that, the next entity change needs a version bump.

### N2: smaller things
- Aim bias: `angle >> 6` floors, and `quantiseAngle` rounds, so a bolt's aim is on average 0.18 degrees low (up to 0.35). The ghost uses the exact angle, so the ghost and the bolt can differ by up to 0.35 degrees (about 1.5 cells at 250 cells). Cosmetic. Rounding in `dir` (`(angle + 32) >> 6`) removes the bias.
- A Rose bolt that hits a player scatters Seed cells inside their hitbox. `Avatar.collides` treats Seed as solid, so the victim can be briefly embedded until the seeds fall (the same stuck-in-material issue as M4a N3). Consider skipping cells inside any player's hitbox in `burst_seeds`.
- `step_projectile` loops all alive players for every sub-step: 256 bolts times 8 sub-steps times players. Fine at the 64-connection cap (about 130k comparisons a tick), but it scales with players, so a spatial pre-filter belongs before M5 raises counts.
- A bolt that leaves the world or reaches `PROJ_MAX_AGE` ends with no `EV_IMPACT`, so a Water bolt that expires over open air makes no splash. Intentional or not, say so.
- `MAX_ENTITIES = 1600` is enough for 64 players plus 256 bolts plus pickups. The truncation is render-only.
- Respawn client path (D-073): the client re-places on any `life` change, which is correct. A double death between two Pos inputs skips a life, and the server rejects the next Pos until the allowance grows (about 2 s). Rare.
