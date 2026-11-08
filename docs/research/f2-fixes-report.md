# F2 review fixes: worker report

## 1. Avatar collision
- Red first: new test `avatar material classes` in `tests/net/avatar.test.ts` failed with `Expected "liquid", Received "solid"` (id 15 Oil) before the fix.
- Fix: `MATERIAL_CLASS` in `shared/names.ts` (index = material id) is the one list; `isGas`/`isLiquid`/`isSolid` in `client/avatar.ts` read it. Gas is a gas, Oil and Acid are liquids (wade, swim).
- Server: no solid set exists in `server/` or `shared/avatar.ts` (grep for isSolid/WATER/LAVA found only client code and unrelated achievement constants). Pos validation is speed-only.
- Sim: no collision physics. `spawn_point` takes the first DIRT/ROCK/SAND/BEDROCK as ground, so liquids are skipped; its `clear` check wants an all-Empty box, so a Gas pocket just makes it try the next column (harmless, left alone).
- Gate: cargo test, clippy, typecheck, test:determinism and test:net all green.

## 2. Acid hurts players
- `CAUSE_ACID = 35` in `sim/src/tuning.rs` and `shared/sim.ts`; `hazard_scan` charges 1 HP when `tick % 4 == 0` and acid touches the hitbox; lava wins over both, fire wins over acid. Toast "dissolved in acid" (with a killer: "X dissolved Y in acid"); 35 added to `SHOVE_CAUSES`. Snapshot and `PLAYER_BYTES` unchanged.
- Red first: `acid_costs_one_hp_every_four_ticks_and_lava_wins` (sim/tests/damage.rs) failed with 0 HP lost vs 5 expected before the `hazard_scan` change. Also covers the CAUSE_ACID death event; toast test extended in `tests/net/toasts.test.ts`.

## 3. Acid pool covering the path
- `try_pool` takes a `keep_off` path (only acid passes one) and rejects a level whose region has any cell within `ACID_PATH_MARGIN`, falling through to the shallower level, before anything is written (so no undo is needed). `generate_with_path` (crate-private) exposes the worm path to tests.
- New test `acid_pools_keep_the_whole_pool_off_the_path`: sizes 0-2, seeds 1-8, an independent Chebyshev distance from every Acid cell to the path, asserting `> ACID_PATH_MARGIN`, and that some acid exists.
- Red first: before the change it failed with `size 0 seed 7: acid at (24,296) is 39 from the path`. `traversable_to_every_band` stays green.

## 4. Gas next to lava
- `place_gas_pockets` now checks Lava over the pocket's whole extent (`r + 4` columns either side, rows from above the ceiling to `GAS_POCKET_ROWS + 14` below) instead of a 14-cell box at one point.
- Tests: `gas_pocket_rejected_when_its_edge_touches_lava` (hand-built cavern, lava 16 cells from the path point, inside the pocket radius; red with the old check: the pocket was placed) and `gas_pockets_keep_clear_of_lava` (sizes 0-2, seeds 1-8, no Gas within 3 cells of Lava, asserts gas exists). Honest note: the world-level test at margin 3 also passed before the fix (min separation on these seeds is between 10 and 16 cells), so the hand-built test is the one that was shown red; the world test guards against regressions.

## 5. Work-count bound
- `new_materials_keep_a_tick_within_bounds` (sim/tests/sleep.rs) no longer uses wall-clock. Per tick over 60 ticks it takes `ran_chunks` and the number of cells whose mat/aux changed, and keeps the max, flash tick included.
- Bound: chunks stepped per tick <= `w*h / CHUNK_AREA` = 64 (every chunk once). Measured max: water 64, acid 64, gas+fire 64 (the packed region keeps the whole sandbox awake, so the bound is exactly met). Tightness is asserted: `max_chunks > bound/2`, so a bound halved to 32 fails (verified by reading the measured 64 against 32; the assertion encodes it).
- Changed cells (reported to /tmp/f2-work.txt, only checked `<=` grid size): water 516, acid 132070 on the first tick (init aux writes, review nit 7) and 2426 after, gas+fire 133700 (the flash). A tight cell-change bound is not meaningful because the flash legitimately changes the whole pocket in one tick; I tried a quarter-area cap and it failed for gas+fire, so I dropped it rather than loosen it silently.
- Wall-clock assertion dropped entirely, as was the /tmp/f2-bounds.txt write.

## 6. Nits
- `tools/inputgen.ts` `MATS` now includes 15-20; "ids 0-14" comments updated in `sim/src/input.rs` and `shared/inputs.ts`. No fixture or expected hash depends on generated scripts (determinism tests compare engines against each other at run time), so none needed regeneration.

## Commit note
The item 3 gate failed because I had started editing `sim/tests/sleep.rs` (item 5) in the same working tree, so item 3 was not committed on its own. Items 3 and 4 both edit `sim/src/gen.rs` and were gated together, then committed as separate commits by file: item 5 (`sleep.rs`), item 6 (tools and comments), and items 3 and 4 together (`gen.rs`). One full gate (cargo test, clippy, typecheck, test:determinism on all four engines, test:net) passed on the final tree.

## Architectural decisions for review
- **Material classes** live in `MATERIAL_CLASS` in `shared/names.ts` (array indexed by id; ids past the end read as undefined, so solid). Alternatives: ranges in `client/avatar.ts` (what broke), or a generated table from `sim/src/materials.rs`. Chosen because `names.ts` is already the data-only shared list and the new test fails if a material is added without a class. Cost: still a hand-kept list; a new material needs a line there and in the test.
- **CAUSE_ACID = 35**, next after GUNPOWDER 34, in `SHOVE_CAUSES`. Cost: an environmental death now counts for "shoved to doom" like lava.
- **Acid damage rate**: 1 HP every 4 ticks (15 HP/s), half lava's rate and above fire's (fire is 1 per 6 ticks per player). Priority lava > fire > acid. Easy to retune in `hazard_scan`.
- **try_pool `keep_off` parameter**: the path check is inside `try_pool`, so a pool that fails at its deepest level can still be placed shallower. Alternative: undo after placing. Chosen because nothing is written until accepted.
- **Work bound** is chunks stepped (<= every chunk once), not cells changed; see item 5.
