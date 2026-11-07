# life-W1 report: surface greenery

## Commit c4b0f48 "World life W1: canopies, shrubs and wildflowers at generation; format 17"
Landed in `sim/src/gen.rs`: `canopy()` (called from `place_trees` at the trunk top, rx 5-8, and each branch tip, rx 2-4;
ry = rx*3/5; ragged rim past 65% of the radius; 1 in 25 cells a FLOWER; Empty cells only; row >= 2; never lower than 12
rows above the ground), `place_greenery()` (40-scaled shrubs, 260-scaled tufts in patches), `plant_site()`.
`place_trees` now returns the trunk columns. Salts 278-284 in `rng.rs`. Format 16 -> 17 (`snapshot.rs`, `server/db.ts`,
heals/bags tests, golden-v17.bin, SCRIPTED_HASH 17345824864577898739, boss_gen hashes, perf trace).
Also widened the unit test `acid_stays_off_the_path_and_gen_materials_are_paintable` to allow FLOWER (surface blossoms).

Tests (`sim/tests/greenery.rs`, seeds 1..=8, sizes 0..=2, pvp and survival), each shown red by breaking the guarded code:
- `every_tree_has_a_canopy` (>= 25 leaf cells within radius 8 of each trunk top): red with the canopy loop skipped.
- `generated_plants_are_static_and_start_with_aux_zero`: red with `put_plant` writing aux 1.
- `surface_has_shrubs_and_tufts_and_none_in_the_spawn_columns`: red with the spawn-column check removed in `plant_site`
  (plant over a spawn column), and red on the floor assertion with `place_greenery` removed.
- `spawn_still_lands_on_dirt_or_rock_with_a_clear_box` (ids 1..=8, 5x10 box): green; not shown red (it guards
  spawn_point behaviour that the spawn-column rule protects; the red spawn-column run above covers the same cause).
- `stepping_with_sleep_on_and_off_hashes_the_same` (600 ticks, S pvp seed 3 and S survival seed 5): green, a guard for
  a future rule change; not shown red (plants are static, nothing to break).
Plant columns resting on the surface (seeds 1..=8): S 15-57, M 109-120, L 439-460; floor asserted at 10.

Pins moved: golden fixture and SCRIPTED_HASH; perf trace: every scenario's snapshot line (format header changes the
bytes, including the sandbox scenarios) and the 300 per-tick `survival_l` lines. Sandbox per-tick lines did not move.
boss_gen non-survival hashes (3) re-recorded.

Look: Read /tmp/w1-s7-m.png (survival seed 7 M) and /tmp/w1-s3-l.png (seed 3 L, x 500+). Crowns read as green trees with
blossoms at the rim; tufts as sparse green/pink specks along flat stretches. Crowns are fairly small and tufts sparse
at M/L; no tuning commit made (left for the lead's taste).

Spend: start 165.59, end about 169.3 (about $3.7). Tool calls under cap.
Not run: determinism, net (lead's).

## Architectural decisions for review
- Canopies clear 12 rows above ground (CANOPY_CLEAR): keeps spawn boxes clear anywhere; alternative was no clearance
  and spawn-column exclusion for trees. Cost: very short trees (14 high) get a crown whose lower edge is clipped.
- `SPAWN_CLEAR_COLS` = SPAWN_JITTER + 7*16 + 8 duplicated as a gen constant; if the spawn scan changes, update it.
- Plant tests treat crowns near trunks as allowed in the spawn columns (trees were already allowed there).
- Tufts/shrubs use existing STEM/FLOWER (flammable, static) rather than a new material: reversible, but they burn.

## Ideas for FUTURE.md
- Scale tuft density with surface length rather than area (M/L feel sparse); bigger crowns for tall trees.
