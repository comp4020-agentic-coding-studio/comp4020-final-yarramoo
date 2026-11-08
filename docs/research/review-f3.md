# Review of F3 (new spells 7-11), `5b63e98..e5a69ae`

Independent cold read by a Sonnet reviewer. Read only: no builds or tests were run. Spell logic (`Acid/Oil/Lava` flasks, Wall, Black Hole) was committed before the base (`6e69d6a`, `7530f28`, `0a5b5a6`), so the diff range holds only the pickup tables, test changes and client work. I read the whole spell code in `sim/src/spells.rs` anyway, since the brief asks about it.

No blockers. Two should-fix items on tests, two on gameplay or client behaviour, and several nits.

## Findings

### 1. [should-fix] The bounded-work test passes on almost anything
`sim/tests/spells.rs:631-646` (`every_spell_cast_at_its_caps_writes_a_bounded_number_of_cells`).
- It steps only seven ticks. The bound is 15*29 + 36 + 2*49*8 = 1255 cells.
- A Black Hole writes only the new cells it clears per tick, about 1.5 cells of advance times 7 rows of the disc. The flasks barely land in seven ticks.
- Scenario: raise `BH_RADIUS` to 7 (the `dig` clamp), or remove the Wall's 36-cell limit. The test still passes.
- The test also counts cells changed, not cells visited, and that is where the cost sits: `dig` scans (2r+1)^2 cells per hole per tick even through empty space.
- Fix: run the holes for their whole `BH_LIFETIME` and assert a per-tick cell-visit or write bound. Or assert a worst case computed from constants, for example `MAX_PROJECTILES * (2*DIG_RADIUS+1)^2`, and check that `BH_RADIUS` is at or below it. `black_holes_are_capped_per_player` (`:596`) is meaningful: it counts holes and charges, and fails if the cap is raised.
- Worst-case work, for the record: 256 projectiles at 49 cells is about 12.5k cell touches per tick. Pull is 256 holes x at most 64 players at one isqrt each (server cap 64; `MAX_PLAYERS` is 1024). This is comparable to the bomb cap (8 x ~1018). Acceptable.

### 2. [should-fix] `m5-state.test.ts` assertions were weakened
`tests/determinism/m5-state.test.ts:~66-76`.
- Before: `marks[90]` had exactly one dead player and a bomb in flight, and `marks[240]` had a dead player and a bag. The test's name says "the cuts include a tick with a dead player and a tick with a bomb in flight".
- Now: `marks[90].dead > 0`, `marks[72].bombs > 0`, and `Object.values(marks).some(dead>0 && bags>0)` over ticks 1..300. The last one is true at any tick, not at a cut tick. Nothing ties a dead player or a bag to a cut any more. The cut list was also rewritten from hand-read timings that the test does not check.
- Scenario: a later change moves all deaths to ticks that no cut covers. The test stays green and the snapshot-restore equivalence at a "dead player" cut is no longer exercised.
- Fix: assert `cuts.some(c => marks[c]?.dead > 0)`, `cuts.some(c => marks[c]?.bags > 0)` and `cuts.some(c => marks[c]?.bombs > 0)`, restricted to cuts of at most 300.
- Smaller points: `entities.test.ts:20` hardcodes `[2,3,4,5,7,8,9,10,11]`, so it would accept a pickup of a spell in the wrong band. It could parse `PICKUP_TABLE` the way `spells-table.test.ts` parses tuning.rs, and check each pickup's band. The `cuts` comment about bomb timelines is unverified prose.

### 3. [should-fix] `claims-live` change: probably benign, but the replacement check is thinner
`tests/net/claims-live.test.ts:84-87`.
- Plausibility: the test places Bo 12 cells from the Bomb spot and casts at angle 0. The explosion radius is 18 (`BOMB_RADIUS`), so the explosion centre only has to land within about 18 of Ana for her to be inside it. A different cave at the new spot makes the bomb hit rock nearer to her, or leaves fire near her. Cause 32 is `CAUSE_FIRE`, a separate death at a different tick. So the second Ana death is plausible and is not a duplicate claim.
- De-duplication in `server/world.ts:1119-1135, 1171`: claims are keyed by `${tick}:${victim}:${killer}:${cause}:${bag}`. `resolvedDeaths` is keyed by `${tick}:${victim}`. Two deaths of the same victim at different ticks are independent, as intended. A duplicate claim for the same tick and victim is dropped in `onClaim`, at line 1121-1123.
- Weakness: the old `toHaveLength(1)` also guarded against any double-count. The filter now guards only Bo. A duplicate or dissenting claim for Ana's death would pass unnoticed. The comment "far enough that Ana's own blast never reaches her" is now false for this seed.
- Fix: also assert that `(victim, tick)` pairs are unique across `ev`, if the log carries `tick`. Better, choose the Bomb spot, or move Bo further (a deterministic open spot), so Ana is clear and the original `toHaveLength(1)` can come back. The loop `for i<12 ... sleep(700)` is timing-based; the worker reran it 3 times, and CLAUDE.md treats a test that passes on a retry as a bug.

### 4. [should-fix, client] Black Hole pull fires every effect of a knock, every tick
`client/worker.ts:603-615` (the pull is an `EV_KNOCK` each tick for up to 150 ticks).
- Each pull sets `hitUntil` and `hitAt` (white flash), calls `fx.streak`, plays the `knock` sfx, and for the local player calls `shake(now, 2, 220)`.
- Scenario: standing within 20 cells of a hole gives about 2.5 s of continuous flashing, shaking and a knock sound every frame. `sfxBudget` caps the sound but not the flash or shake.
- Also, `MAX_EVENTS` is 256 (`shared/sim.ts:89`). Many holes x players can truncate the event list. This is harmless for sim state, but the local `avatar.knock` is driven from the same events (`worker.ts:256`) and could drop a pull.
- Fix: give the pull its own event `c` marker (for example `c = -1`) or a new `EV_PULL`, and render it quietly. The `EV_*` numbers are not hashed, but adding one changes the ABI view, so the `c` marker is the cheaper option.

### 5. [nit, design] Pull is ungated: the D-158 consequence
`sim/src/spells.rs:~270-285` (`step_black_hole`).
- The pull uses the `EV_KNOCK` path with `c = 0`, gated by `alive()` and by range (`BH_PULL_RANGE`) only. `d2 == 0` is skipped, so the isqrt division is safe, and `dist` is at least 1.
- It pulls the owner and every teammate, regardless of `damage_from_players()`, and it ignores terrain (a hole pulls through rock). It does not credit a kill, because `last_hit_by` is untouched.
- D-158: Black Hole's pull would need the same gate as Push and Blast, "gate player-on-player knockback when `damage_from_players()` is false". Decide whether the owner is exempt. Pulling a teammate into lava in a co-op room is the same hazard D-158 names. Add it to the enemies brief's gate list, as `spells.rs:450-456` is already named there. No change needed now.

### 6. [nit] Wall can seal a pickup or bag
`spells.rs:wall_cast`. It writes `ROCK` over any Empty, gas or liquid cell that is not inside an alive hitbox. Pickup spots and bags are entities, so a Wall at a spot makes the pickup unreachable until someone digs. It is griefable only by spending a scarce charge, and Dig is infinite. Not a determinism issue. Optional: skip cells that hold a pickup or bag.

### 7. [nit] Smaller items
- `server/db.ts:9` has `SNAPSHOT_FORMAT_VERSION = 3`, but the sim is at 6. It is metadata only (the sim checks its own header, `snapshot.rs:61`), but it is stale and misleading. Format 6 makes older stored game snapshots unrestorable. That is fine while the game is "not live"; check that a failed restore of an old snapshot falls back to a fresh world and does not crash the room.
- `sim/src/gen.rs:1491-1492` (the ignored measurement test) still classifies bands by `spell < 4`, which is wrong under the new tables. It is ignored and only writes `/tmp`, so it is cosmetic.
- `client/worker.ts:733` hardcodes `spell !== 9` for the Wall ghost. Use a named constant. A `speed === 0` test would also suppress Blast and Dig, which do use ghosts today.
- `client/worker.ts:580-583`: Wall's cast fx is `dust` at the caster. It is cosmetic, drawn at the caster along the aim, not on the slab at 10 cells.
- Q/E (`client/room.ts:422`) do not check `e.repeat`, so holding the key spins through the bar. Add `!e.repeat`.
- `tests/net/spells-table.test.ts` does not check that `BAR` is a permutation of `0..NUM_SPELLS`, or that `shared/sim.ts` `NUM_SPELLS` equals `tuning.rs`. The `SPELLS.length` check in `client/spells.ts:33` guards only the client table.
- Black Hole's dig primes Gunpowder (`grid.rs:847`), as Dig does. A hole boring through a gunpowder seam primes new cells every tick. This is bounded and deterministic, and it is existing Dig semantics. Noted only.

## Answers to the specific questions

### 1. Black Hole and the active region
- Projectiles step regardless of the active set. `Sim::step` runs inputs, then `update_entities` (`sim.rs:151`, `update_projectiles` at `sim.rs:285`), then `refresh_active` (`sim.rs:156`, `185-193`), then `step_cells`. Nothing in `update_projectiles`, `step_projectile` or `step_black_hole` (`spells.rs:202-285`) reads `grid.active`. So yes, a hole can fly into and dig a frozen chunk. It flies at 1.5 cells per tick for at most 150 ticks, so at most 225 cells, and it ends when it leaves the world. Holes already in flight keep going when their owner leaves; a cast from an inactive player is refused (`spells.rs:65`).
- Writes into a frozen chunk go through `Grid::set` -> `touch` (`grid.rs:100-125`), which sets `dirty_since_hash`, clears `pristine` and sets `awake`. Frozen chunks are already forced to `awake = true` every tick (`grid.rs:183-187`, the `!self.active[c]` branch), so the write changes nothing about wake state. When the chunk later becomes active it runs on its first tick, with or without the write. This does not depend on `sleep_enabled`.
- Determinism: all clients run `update_projectiles` identically, since the active set derives from hashed player state. D7 invisibility: sleeping skips only active, non-awake chunks; `touch` wakes the written chunk and its neighbours at the edges, as for every other spell. `d7_black_hole_boring_through_a_sleeping_region_is_invisible` (`sim/tests/sleep.rs:269`) exercises exactly this, with a hole bored through rock 100+ cells from the player. Verdict: not an invariant break. The worker's open question is answered: it is "as safe as ordinary projectiles", and bombs and bolts behave the same way.

### 2. The pull
- It uses `EV_KNOCK` (`spells.rs:~281`). It is gated by `t.alive(tick)` and by range (`d2 > range*range` is skipped), and `d2 == 0` is skipped. It is bounded: `BH_PULL` is 12 (1/16 cell per tick) per hole per tick, against `KNOCK_PUSH` 64 and `KNOCK_EXPLOSION` 96. The client's `avatar.knock` also caps velocity (`client/avatar.ts:76`). Work is one loop over the players per hole. See finding 5 for D-158.

### 3. `NUM_SPELLS`-sized layouts
All consistent:
- Rust `PLAYER_BYTES = 21 + 6*NUM_SPELLS + 8` (`entities.rs:25`) equals `PLAYER_RECORD` in `server/world.ts:1289` (21 + 72 + 8).
- `PLAYER_VIEW_BYTES = 4*NUM_SPELLS` (`entities.rs:421`) equals `withBuf(4*NUM_SPELLS)` and the offsets in `shared/sim.ts:184-191`.
- Tuning arrays (`START_CHARGES`, `PICKUP_CHARGES`, `SPELL_ENABLED`, `COOLDOWN`, `SPEED`, `GRAVITY_Q8`) all have 12 entries (checked by the type).
- `client/spells.ts` has 12 entries with the length check at line 33, and names match `shared/names.ts`. `shared/stats.ts` derives keys from the names.
- Bag: `BAG_SPELL_IDS = [2,3,4,5,7,8,9,10,11]`, `BAG_BYTES = 2+2+2*9+4 = 26`. Encode (`Bag::write`), decode (`entities.rs:308-318`), merge (`drop_bag`, `spells.rs:495-513`), death collection (`spells.rs:474-478`) and pickup (`spells.rs:552`) all index through `BAG_SPELL_IDS`. `sim/tests/bags.rs:472` pins the table to the finite spells. Infinite charges (Creative) are never bagged.
- Snapshot format 6 (`snapshot.rs:10`) covers the player record, bag record and projectile spell check (`spell < NUM_SPELLS`). The decode length check `bag_at + 4 + nb*BAG_BYTES == len` is exact.

### 4. Bounded work
- Flask bursts: `burst` scans 13 x 13 cells and fills at most `cap.min(OIL_BURST_CELLS)` (70) Empty cells (`spells.rs:~420-440`). The lava `down` ordering is correct (dy runs from 6 down to -6).
- Wall: 3 x 12 = 36 cells. It writes only `EMPTY`, gas or liquid, so never Bedrock or other solids, and it skips every alive player's hitbox. A dead player's corpse is not protected, which is fine. Bounds are checked per cell.
- Perpendicular maths: the largest intermediates are `pc * u * POS_ONE` = 16384 x 6 x 16 = about 1.6M, and `c * WALL_REACH * POS_ONE` = about 2.6M, both far inside `i32`. Division truncates toward zero for negatives and the shift floors; both are deterministic. The slab may be ragged at diagonals but is 3 cells thick, so it is not leaky.
- Black Hole dig: `Grid::dig` clamps `r` to `DIG_RADIUS`, scans at most 7 x 7, and skips Bedrock and liquids. Per-player cap 2 (`MAX_BLACK_HOLES_PER_PLAYER`), plus 12 projectiles per player and 256 overall. Weak test: finding 1.

### 5. Determinism
- No floats in `sim/` (`#![deny(clippy::float_arithmetic)]` is in `lib.rs:2`). No `usize` in any hash path added. No new salts at all: F3 adds none, and reuses `SALT_BURST` (seeds only) and `SALT_PICKUP_SPELL`. There are no duplicate salt values in `rng.rs`.
- The pickup table is integer-only: `rng(seed, 0, i as u32, 0, SALT_PICKUP_SPELL) % total` over `PICKUP_TABLE` weights, with a deterministic fall-through to `table[0]`. It is seeded, and `Sim::new` twice gives equal pickups (tested at `spells.rs:~652`). The `find` closure mutates `roll` in iteration order, which is fine, if a little clever.
- The weighted-test thresholds (`got*2 > want && got < want*2` over 8 seeds) are loose but meaningful for a mis-wired table.

### 6. Test expectations
See findings 2 and 3. Nothing was weakened in `sim/tests` (`players.rs` generalises to the tables; `gen.rs` band classifier follows the table). The TS tests moved with the data.

### 7. Client
- Q/E: `at = max(0, indexOf)`, `e` goes to `(at+1) % len`, `q` to `(at+len-1) % len`. Correct, wraps both ways, gated by `castsOnClick()` and `!ctrlKey/!metaKey`, and the digit keys are limited to 9. Render and input selection only: `selectedSpell` feeds a Cast input, and nothing from sim output feeds it.
- Wall ghost is suppressed for spell 9 only (nit above). Black Hole has gravity 0, so a straight ghost is correct.
- New fx read only `entities()` and `events()` and write particles and rects (`swirlIn` uses the client's own `rand`). The pull's `EV_KNOCK -> avatar.knock` is the existing sanctioned path (the avatar is client-predicted and its movement becomes Pos inputs). No new feedback into the sim (invariant 9).
- Not verified: no browser look and no second tab (the worker says so). Treat the swirl, bar wrap and flash behaviour (finding 4) as unseen.

## Checked and fine
Cast gating and charge accounting in `cast`; `REJECT_FULL` for the Black Hole cap; `Wall` exempt from projectile caps but limited by cooldown and charges; projectile snapshot decode bounds; `BH_LIFETIME` expiry with an `EV_IMPACT`; `d2 == 0` guard; `isqrt` on `u64`; pickup band selection (`sp.band != 0`); `PICKUP_CHARGES` indexing by spell; bag pickup and drop `INFINITE` handling; HUD view layout; HTML spell bar wrap.
