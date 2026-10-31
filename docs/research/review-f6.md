# Independent review of F6 (the boss), diff 540c25d..90b4849

Read-only review: git and reading only, no tests run. "Confirmed" means read in the code. "Suspect" means reasoned, not demonstrated.

## Should-fix

### S1. No test proves a Survival world is still traversable to the bottom band (confirmed gap, effect suspected)
- `sim/src/gen.rs:1757` (`traversable_to_every_band`) loops over `RoomConfig::caves_pvp()`. `generate_world(.., with_arena = false)` is byte-identical there (also pinned by `boss_gen.rs` hashes), so the test cannot see the arena at all.
- `carve_arena` (gen.rs ~L350-L410) fills every Empty cell at or below `floor_y` inside the ellipse with Rock, a flat slab across the lower half. The arena is centred on a worm-path point in the deep band, so a worm tunnel that continues downward through the lower half of the ellipse is severed. Recovery depends on `connect_and_prune` and `repair_traversal`, which run afterwards.
- `repair_traversal` tunnels via `wander_link`. A tunnel can cut the arena floor (a hole in the flat floor, a ring lava leak) or the alcove. `boss_gen.rs` only checks the arena centre is reachable and the floor is solid, for 3 sizes x seeds 1-8.
- Fix: parametrise `traversable_to_every_band` over `RoomConfig::survival()` (sizes 0-2, seeds 1-8, and more seeds if cheap), asserting `deepest_box_reach >= traversal_target_for(h)`. Extend the floor-hole assertion to the whole floor row of the ellipse and more seeds.

### S2. A world with no arena has no boss, so Survival can never be won (confirmed behaviour, suspect trigger)
- `carve_arena` returns `None` when no clear, sky-open path point exists (gen.rs `if cands.is_empty() { return None; }`). `Sim::new` then places no boss, and `round_won` is only ever true when a boss dies. `Survival` rooms would be unwinnable and lose silently.
- The test only asserts an arena exists for seeds 1-8. Room seeds in production are arbitrary.
- Fix: a last-resort fallback (the nearest path point regardless of `clear`/`open`, or a wider search). Failing that, a test over e.g. 200 seeds at size S (the tightest: rx 40, `reach` 76 against the border margins) asserting `arena.is_some()`.

### S3. Cross-engine determinism (D2) only covers phase 1 (confirmed, disclosed)
- Committed `bossScript` never reaches phase 2 (`node.test.ts` at 90b4849 says so). Summons (rng cells, id counter), the ring (`Grid::set`), the fan and bombs run only in Node-native `sim/tests`, never on wasm in Chromium, Firefox or WebKit. D1/D6 on wasm do not see them either.
- Note: the working tree currently has uncommitted edits to `node.test.ts` and `helpers.ts` that assert phase 3 or death. That is the right direction. Confirm the final script really reaches phase 3 (assert an EV_ENEMY_PHASE b=3 event on the browser path too, not just Node).
- Fix: have the script force the phases (e.g. a long Bomb and Fire barrage from a well-supplied party, or a test-only dev hook). Browser compare should assert phase-3 events exist.

### S4. The D7 test compares only the entity section (confirmed, `sim/tests/boss_win.rs:159-187`)
- The ring's lava goes through `Grid::set` (touches and wakes chunks) and spreads under the sleeping logic. The test deliberately drops `mat`/`aux` and compares only entities, so a sleep-dependent ring result in the grid would pass. The comment defers to the sim's own D7, which does not exercise the ring.
- Fix: also compare the grid (`mat` and `aux`, via full `snapshot::write` equality if the sleeping set is not serialised, otherwise compare `grid.mat`/`grid.aux`).

### S5. The new tests have not been shown red (confirmed, admitted in the worker report)
- The win test and the phase tests were not run against a stub. The brief and CLAUDE.md require this. Cheapest checks:
  - make `round_won` return false and run `boss_win`;
  - change `BOSS_SUMMONS_ALIVE` to 8 and run `boss_phases`;
  - break the id formula and run the sorted-ids test.
- `a_scripted_player_kills_the_boss...` pins the player's position and health every tick (`s.players[0].x = ...`; `health = HEALTH_MAX`). That is scaffolding, but it means no test shows a normal player surviving or killing the boss.

## Nits

### N1. The client treats the boss as a worm (confirmed, disclosed as unfinished)
- `client/worker.ts:163`: `ENEMY_MAX_HP = [20,30,60,90]`, so `[4]` falls to `?? 20` and `hpFrac = hp/20 = 60` (no bar). `client/fx.ts:85` renders kinds above 2 as the WORM sprite. `shared/sim.ts` has no EV 14.
- The shared state bits do not collide with client readers: the client reads `health & 1` (hunting) and `health & 2` (airborne). Boss phase bits 2-3 are ignored, and `facing << 7` is above them. Fine.
- `ENT_ROUND` readers use `a` and `sub` only. Round byte `b` can now be 2 or 3 and nobody reads it. D-161's late-join check (`sim.rs:318`, `round_started != 0`) still behaves: bit 1 implies a kill happened, and `round_over` is set at the same time.

### N2. `rng.rs` constants appended after the `mod tests` block (rng.rs:146-150)
- Salts 250-254 sit after `#[cfg(test)] mod tests`, outside the salt table. Collision check: 249 is the last used salt before, so there is no clash, but move them into the table next to the other salts.

### N3. Two bosses via a hostile snapshot (suspect, harmless)
- Decode does not limit the count of `ENEMY_BOSS`. `stepping_set` steps only the first boss, so a second never steps, so there is no unbounded work. Harmless, but a count check is a one-liner.
- A snapshot with `round_started` bit 1 and no boss decodes (<=3 accepted) and wins at once in a round-1 world. This only hurts the sender's own state, and the server restores from its own snapshots. Fine.

## Confirmed OK (checked in the code)
- **Summon ids.** Placed enemies get ids 0..n-1 and the boss gets n, the highest. No normal enemy is placed after the boss (`boss` is pushed last in `Sim::new`). Summons get `boss.id + 1 + hop_until`, `hop_until` only grows and is capped at 40, so ids are unique, appended at the end (sorted), and cannot reach another enemy's id. Max id < 64 + 41 << 4096, so the `as u16` cannot wrap. The decode guard `id + 1 + hop_until < 4096` and `hop_until <= 40` hold after a snapshot. `Sim::new_with_base` rebuilds the arena from the seed.
- **Pushing during the stepping loop.** `stepping_set` indices are computed before the loop, and summons are appended past them, so no index shifts and new imps first step next tick. `alive` counts imps with `id > boss.id`, which cannot match placed imps (their ids are lower).
- **`hop_until` reuse.** The boss branch in `step_enemy` returns before the slime hop logic (`enemy.rs:409` reads `hop_until` only for slimes). No other reader.
- **Phase in `state` bits 2-3.** Decode requires phase 1..3 and `state < 16` for the boss, and `state <= 3` for everything else. `step_enemy` saves and restores the phase bits around `integrate`, which would otherwise overwrite them with the airborne bit. Phase only rises.
- **Win from hashed state.** `round_started` bit 1 is part of the hashed snapshot tail. `write_view` emits `round[0]`/`round[2]` for the client, so a reconnecting client sees `round_over` and `round_result` from state. Win beats loss on the same tick (`check_round_end`, tested).
- **Bounded work.** The ring is at most 24 `Grid::set` writes, every 240 ticks. Summons are at most 2 per cast, 8 tries x 20 cells, every 300 ticks, capped at 4 alive and 40 total. The fan is 3 bolts capped by the existing enemy-projectile cap. `stepping_set` is capped at 24, with the boss first. The leash is O(1). The measured maximum is 1226 cells per tick, against a test bound of 1400.
- **No floats, no HashMap, no host imports.** Integer arithmetic throughout (`cells*cells/620`, `rx*433/500`, i64 ellipse test). Indices in the ring and the summon check are computed under `contains`. The summon check uses `contains(.., -2)` before indexing. The alcove is guarded by `near_border(.. reach)`.
- **Non-Survival worlds.** `with_arena` is false for non-enemy worlds. `generate_world` early-outs the same RNG sequence (arena salts are fresh: 250-254). `boss_gen.rs` pins hashes of three PvP worlds recorded before the change. That test can fail.
- **Copy-before-use.** `Pickup` with `fixed` is appended after `pick_spots`, so earlier pickup ids are unchanged.

## Not verified
- I did not find `__devBossHp` anywhere in `client/`, `server/`, `shared/` or `tests/` at this commit (the grep found only `__devPaint`, `__devGoto`, `__devGotoEnemy`, `__devMe`). The brief's check is moot until the client slice adds it. Re-check when it lands that it sits inside the same dev-route guard (`client/room.ts:977-990`).
- Arena carving may create unsupported rock islands that `crumble_islands` drops on the first tick (suspect, not measured).
- Whether `check_round_end` (sim.rs:195-201) runs inside the branch a boss-death tick takes was not traced beyond the same-tick test.
