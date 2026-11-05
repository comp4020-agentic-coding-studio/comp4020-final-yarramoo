# Biomes worker 2 report (brief biomes-2)

## Commit 1: generation time (7b33212)
Native gen, caves_pvp, best of 4 seeds (`measure_gen_time`, now also prints worst; `GEN_SURV=1` uses survival):
before S 82 / M 130 / L 682 ms (brief says 691); after S 84 / M 133 / L ~490 ms. Target of ~400 was not fully met.
Changes: `carve_sites` takes the reference depth once, carves all sites, checks once (falls back to the per-site
check only on failure; bowls only add solids so depth is monotone); `box_reach` prefix sum in one pass plus
`depth_reaches` early exit used by carve_sites and fill_lava_lakes; `fill_lava_lakes` hoists the reference depth
(re-based after a dam that itself shortens the route, which keeps lake counts identical).
Stage timings at L afterwards (ms): carve_sites ~90, fill_lava_lakes ~100-130, repair_traversal ~40, place_water ~45, rest small.
No generated world changed; no pins moved.

## Commit 2: ice floors (hash in log)
Floor row and row below become spent Ice across the cavern (grown by 4); lid now reaches the shore (still limited to water inside the cavern ellipse shrunk by 6x3). Test `ice_sites_hold_a_frozen_lake...` asserts floor-row ice >= 1.5 rx (measured min 1.75 rx); shown red on the old code (size 0 seed 1: 34 cells, rx 39). Pins moved: SCRIPTED_HASH, golden-v14.bin, perf-trace survival_l (150 lines + snapshot), boss_gen non-survival hashes. Sandbox scenarios did not move.

## Commit 3: the three materials (dafaa70), green incl. test:determinism and test:net
Brick 22 / Moss 23 / Mushroom 24 end to end (materials.rs, grid.rs structural/dissolvable/dig+blast/fire chance 1 in 40 and 1 in 6, names.ts, MATERIAL_CLASS, hotbar, input.rs comments, class pin tests count 25, stats test uses id 25 as the past-the-end id). Shown red: `acid_leaves_brick_and_eats_moss` (brick dissolvable) and the moss-vs-wood ratio test (moss at 1 in 12). Measured 120 ticks, 6 seeds, 40-cell row, 2 fires: wood 114, moss 26, mushroom 235 cells burnt. New `sim/tests/biome_materials.rs` and `d7_brick_moss_mushroom_sleep_is_invisible` in sleep.rs. No pin moved. `is_flammable` callers checked: lava ignite and lava volatility use it directly (moss and mushroom next to lava now keep it awake and ignite 1 in 8, as Wood does); fire lingering on fuel likewise.

## Commits 4 and 5 (grotto, mine): NOT done, left as a patch
A full first implementation exists in `docs/research/biomes-w2-grotto-mine-wip.patch` (apply with `git apply`, also at /tmp/b2-grotto-mine-wip.patch): `BIOME_GROTTO=3`, `BIOME_MINE=4` in the picker, salts 266-268, `place_biome_halls`/`place_grotto`/`place_mine`, dump_world palette, a `grotto_and_mine_exist_...` test in biomes.rs (green), a `LAVA_SITE_GAP = 90` (extra keep-away between lava sites and other sites: with the two new kinds a neighbouring cavern drained 4 lava lakes, which failed `lava_lakes_hold_lava` at L; with the larger gap lakes matched the old numbers). It is NOT green; the full `cargo test` failed these:
- `boss_gen`: arena holes in the floor, arena unreachable (S seed 7, L seeds 4 and 7), enemies/supply in the arena. The two new site kinds are picked after the arena is carved, but their bowls and caverns change the worm network around it; the existing depth check does not guard arena reachability. Next step: reject candidate sites that intersect the arena grown by ARENA_KEEP_OUT + a wider margin, and check `repair_traversal` no longer cuts the arena floor.
- `enemies.rs` slimes_stand_on_floors: a slime floor was Moss (id 23) because I added MOSS|BRICK to `solid_ground`. Revert that (leave `solid_ground` as it was) so spawns avoid moss tufts.
- `determinism.rs every_world_gets_its_full_set_of_pickups`: L seed 4 had 22 deep pickups (< 25): the mine sites (deep_top..+250) eat deep floor. Raise the deep spot tries again or shrink mine count at L.
- `non_survival_worlds_are_byte_for_byte_unchanged`, golden, perf-trace: would need re-recording once green.
- Test fixes that were needed and are in the patch: `acid_stays_off_the_path_and_gen_materials_are_paintable` allows STEM (grotto mushroom stalks are Stem, not paintable); the stranded-cells check in `place_biome_halls` (a cap or beam can plug a way into a hall).
- Gen time after the patch (L, best of 4): ~600 ms, because `place_biome_halls` clones the grid and floods; the 400 ms target would need a local (per-site) check.

## Gen time summary
S/M/L before: 82 / 130 / 682 ms. After commit 1 (and so after commits 2-3): 84 / 133 / ~490 ms (L ~460-500 across runs, machine load 2-3). Target 400 ms not met; stage timings are in commit 1's section.

## Architectural decisions for review
1. **carve_sites and place_biome_halls check the route once for all sites, falling back to per-site checks only on failure.** Alternative: per-site checks (slow). Valid because bowls/decorations only add solids, so depth is monotone. Cost: on failure, the per-site pass clones the grid.
2. **`box_reach` has an early-exit variant (`depth_reaches`) and a one-pass prefix sum.** `box_reach` itself is unchanged in behaviour.
3. **fill_lava_lakes rebases its reference depth after a dam that itself shortens the route** (otherwise, with the hoisted reference, 22 of 48 L lakes were undone; the pins stayed identical to before).
4. **Ice floor is 2 rows of spent Ice across the whole cavern width, lid reaches the shore**; test floor-row ice >= 1.5 rx.
5. **Moss/Mushroom are flammable via `is_flammable`**, so lava volatility and lingering fire apply to them without special cases; ignite chance is a match arm in `update_fire`.
6. **The paint-range mirror in names.ts is now two ranges** (10-20 and 22-24); id 21 stays a hole.
7. **Grotto/mine (unfinished): `LAVA_SITE_GAP`** (above) and decoration written only into Empty, checked against walkable depth and stranded cells.

## Ideas for FUTURE.md
- Per-site local depth check (bounded flood around the site) instead of whole-grid clones, to reach the 400 ms target.
- Sites should be picked before the worms and arena, so the network is built around them instead of repaired after.
