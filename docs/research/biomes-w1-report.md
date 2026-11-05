# Biomes worker 1 report (brief biomes-1)

## Commits
1. `f7ca386` dump_world tool (`cargo run --release --example dump_world -- SEED SIZE PRESET out.ppm`, 32-entry palette).
2. `e20541c` format 14. Only snapshot-bytes hashes moved: `golden-v14.bin` and the 9 `snapshot` lines of `perf-trace.txt` (the version byte is in the header; every scenario, sandbox included, because the line hashes snapshot bytes, not state). State-hash lines, `SCRIPTED_HASH`, `boss_gen` did not move. Also fixed pinned `13`s in `bags.rs`, `config_state.rs` (the "future format" probe 14 became 13 + 15).
3. `a558a26` site picker + lava lakes + `sim/tests/biomes.rs`. Moved: `SCRIPTED_HASH`, golden fixture, `perf-trace.txt` `survival_l` lines only (sandbox and all other scenarios unchanged), all three `boss_gen` non-survival hashes (comment updated).
4. `c09fa76` ice caves: moved again `SCRIPTED_HASH`, golden fixture, `survival_l`, boss_gen hashes.
5. Ice sliding + avatar test + this report (final commit, hash in the handback).

## Measurements
- S (512x512, pvp) per seed 1..8 (lava, ice) site counts: (1,1) for every seed. L and M always have at least one of each (asserted, all seeds, both presets).
- Lava sites at size S/M/L: most hold 1000+ cells at M and L (the test asserts at least half of sites hold 150 / 1000 / 1500 cells at S / M / L). Some sites hold 0: the pool needs a floor and a basin under the cap (see decisions).
- Ice: 70 of 80 ice sites (seeds 1..8, 3 sizes, 2 presets) hold water.

## Tests shown red first
- `every_large_and_medium_world_has_a_lava_site_and_an_ice_site`: red with `pick_sites` returning nothing ("size 1 seed 1: lava 0 ice 0").
- `sites_do_not_overlap_...`: red with the overlap check removed (two lava sites overlapped at L seed 1).
- `lava_lakes_hold_lava...`: red with `fill_lava_lakes` removed ("only 1 of 16 lava sites hold 150+ cells").
- `generated_ice_is_spent`: red with `aux = 0` ("fresh ice at 236,265").
- `ice_sites_hold_a_frozen_lake...`: red with `place_ice` removed ("ice site ... holds 0 ice").
- avatar slide test: red with the ice branch disabled ("expected 1.0625 to be greater than 8"); green with it.
- Existing `traversable_to_every_band`, `every_open_cell_is_reachable_from_the_sky`, boss_gen arena tests: unchanged. They failed during development (floating pocket after a dam, ice lid capping a side tunnel, a lake drowning the route so `repair_traversal` cut the arena floor) and generation was fixed each time.

## Problems met (generation, not tests, was changed)
- Pickup count: lava lakes cover deep floor, one seed fell to 18 deep pickups (< 25). `pick_spots` tries raised 4000 -> 20000 (loop still stops at `want`).
- `tests/enemy_worm.rs` `rock_arena` cleared only Acid before filling a Rock block; a lava lake under that block melted Rock. It now also clears Lava (test fixture, not a weakened assertion).

## Architectural decisions for review
1. **Sites are a `Vec<Site>` on `World`, picked from path points that are open to the sky.** Alternative: any path point. Open-only avoids sites that `connect_and_prune` would fill. Cost later: later biomes (grotto, mine) reuse `pick_sites`; add kinds to the loop and `BIOME_*` constants.
2. **Every site cavern has a flat floor (`site_floor = cy + ry/2`, bowl sealed below) and a rim dam (`dam_site` / `seal_site`)** run after `connect_and_prune`. A dam that would strand more than `DAM_STRAND_MAX` (1500) cells is undone; smaller stranded pockets are filled. The bowl is also undone if it reduces `box_reach` depth. Alternative: no dam (lakes failed: 11-12 of 16 sites never filled at L). Cost: sites are bowls, not organic caves; later slices can reuse `seal_site`.
3. **A lava lake that makes the walkable depth shallower is undone** (`fill_lava_lakes`); otherwise `repair_traversal` cut through the boss arena floor (boss_gen test). Cost: a few lake sites stay empty.
4. **`try_pool` gained `max_w` (70 for old calls).** Existing results do not move.
5. **Ice lid** is 2 rows, kept 3 columns from the shore and inside the cavern ellipse (shrunk by 6x3) so the pool stays joined to open cave (`every_open_cell_is_reachable_from_the_sky`). A pool with no lid at the shore means players can fall in from the edges. Cost: lid not wall to wall.
6. **`scale_count(w,h,3,1)` gives 1 site per kind at S and M, 3 at L**; radii scale with the chambers' width percentage. Salts 260-265 in `rng.rs`.
7. **Ice client constants**: `ICE_ID = 18` is duplicated in `client/avatar.ts` (pinned by the existing material-class test only through `MATERIAL_CLASS`); `ICE_BLEND = 0.04`, exported.
8. **Pick spots tries x5** (above). Cheap since the loop exits at `want`, but generation time on a sparse world grows.
9. **PERF trace**: `perf-trace.txt` "snapshot" lines change on any format bump even for sandbox scenarios; a future format bump should expect that.

## Ideas for FUTURE.md
- Lava lakes with a rock bridge over them (plan A1 mentions it); this slice only has ledges.
- Ice-sliding for enemies (needs sim work).
- `dump_world` could mark sites with an outline (needs `World` exposed from `Sim`).
