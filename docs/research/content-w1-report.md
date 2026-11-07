# content-W1 report: surface ruins and wells

Spend: S0 $243.05; after commit 1 $247.41; finished about $248.

## Commit 1 (b8217d9): houses, wells, format 19, pinned values
The brief split houses and wells into two commits. I built both in one pass because they share `struct_site`, the
spacing and the keep-out rules, so the first commit holds both generators; the wells tests landed in commit 2 below.
`place_structures` runs after `place_trees` and before `place_greenery` (greenery's `plant_site` now also skips any
structure's columns plus 2). `World.structures` is test-only output (`Structure { kind, x0, x1, top, floor, bottom }`).

What I saw in the dumps (M seed 5, L seed 3): houses read as orange Wood roofs on thin Brick walls standing on the
surface, spaced well apart, with greenery stopping short of them; a well shows as a dark shaft with a coping. At L seed
3 the left edge shows a tall frame with a dark shaft down.

Counts (seeds 1..=8, both presets, so 16 worlds per size): M: houses in 16/16 worlds (16 houses, 1 per world), wells
in 16/16 (0 cave, 16 water). L: houses in 16/16 (48, 3 per world), wells in 16/16 (16 cave, 16 water, 2 per world).
Size 0 (S) also gets them (1 house, 1 well). The M well is always the water kind: `scale_u(768, 120)` is 60 rows of
reach and no cave is that near the surface there.

Enemy count of an L Survival world (seed 1): 64, unchanged (`MAX_ENEMIES`).

Tests (sim/tests/structures.rs), each shown red first by breaking what it guards:
- `structures_keep_out_of_the_spawn_columns_and_the_arena`: red with spawn-column margin set to 0: "structure
  Structure { kind: 0, x0: 287, x1: 316 ... } in the spawn columns".
- `houses_can_be_walked_through_and_entered`: red with the door 2 rows short: "door at 44,58 is shut".
- `houses_stand_on_the_ground_and_never_float`: red with a stray Brick cell planted at the door-line height:
  "house at 44 floats a cell below the door line".
- `fire_on_a_roof_is_bounded_and_sleep_invisible`: red with the bound tightened to `burned < 1`: "burned 1".
  Result: a roof fire burns 1 Wood and 1 Fire cell remains at tick 1200 (a stuck ember), sleep on and off hash equal.
  So the assert is `fire <= 3` and `burned <= 400`, chosen from what was seen.
- `structures_exist_at_medium_and_large`: red with `with_house >= 17`: "size 1: only 16/16 worlds have a house".
  Thresholds are 12/16 for houses and 8/16 for wells (the brief's 12-of-16 and half).

Pins moved: `FORMAT_VERSION` 19 (snapshot.rs doc line, db.ts, bags.rs, heals.rs); `golden-v19.bin` and
`SCRIPTED_HASH = 11173943090445512075`; `perf-trace.txt` (the `survival_l`, `creative_m_spells` lines and every
`snapshot` line; the sandbox scenarios' per-tick state hashes did not move, only their `snapshot` lines, which embed the
format version); `boss_gen.rs` non-survival hashes `[7331383556986496254, 9678034947065928620, 4739404430958194927]`
(PvP worlds get structures too). All existing generator tests stayed green unchanged.

Design points found while testing:
- A walkable 12-row door at floor level means the wall above each door, and the roof, cannot be 4-connected down to the
  ground in a side view. The arch (lintels, roof, chimney) is therefore a bounded bridge of under ~120 cells that rests
  on nothing but each wall's two door-side columns; it is above the door line. The brief's "never float" test is
  relaxed to: everything below the door line is grounded, and the arch is the exception. The wall columns stay Brick
  (2 thick each side), the arch's inner columns are anchored to nothing, so it can fall (`falling_islands`) when
  disturbed. That is cosmetic and bounded.
- A tree trunk within 6 columns left a canopy branch walling the door off; trunks now keep 14 columns clear of a house.
- The first well drew a closed box (posts, coping, a full crossbeam) that stranded the sky flood (the
  `every_open_cell_is_reachable_from_the_sky` test caught it). The crossbeam is now a 3-cell cantilever from the left
  post, with a 5-wide gap beside it.
- Spawn exclusion: `ENEMY_SPAWN_CLEAR` (160) is narrower than `SPAWN_CLEAR_COLS` (168), so `SPAWN_CLEAR_COLS` is the
  binding limit and the only one used (made `pub` for the tests).

## Commit 2: wells tests, salts test, report
- `wells_open_to_a_reachable_cave_or_hold_water_on_solid`: red with a Rock plug placed in a cave well's shaft: "shaft
  cell 607,219 is not open"; and with the water cut to rows far from the pit floor: "only 0 water cells" (the bare water
  floor check). I did not find a red for "the opening is not reachable from the sky" separately: the plug trips the
  shaft check first.
- `salts_are_unique`: several older salts already share values (260, 261, ...), and changing one moves every pinned
  world, so the test checks only salts declared from the content-W1 comment on. Red with `SALT_GEN_WELL_DIM` set to 284:
  "SALT_GEN_WELL_DIM shares the salt 284 with [SALT_GEN_TUFT_DIM]".
- `a_large_survival_world_keeps_its_enemy_budget`: 64 enemies (writes the count to /tmp/cw1-enemies.txt).

## Architectural decisions for review
1. **`Structure` as test-only generation output on `World`.** Alternatives: re-derive from the grid in tests, or add to
   `Sim`. Chosen because it keeps the sim state and snapshot layout untouched. Cost: the field must be kept in step with
   the placement code.
2. **The roof/lintel arch is unsupported (relaxed "never float").** Alternatives: a door shorter than 12 rows so a
   header can be supported from the side, or buttress columns inside the door. Chosen to satisfy "12 rows tall, walk
   straight through". Cost: a house can shed its upper walls when something near it is removed; if the lead wants it
   rock solid, make the roof thinner and add Brick pillars in the door gap.
3. **Well beam is a 3-cell cantilever, not a full crossbeam.** Alternative: a full beam plus a door-like gap in a post.
   Cost: a bucket line is only a stub.
4. **Water wells use a Brick lining only 8 rows down; the pit below is raw Dirt/Rock, shaft 7 wide.** Cost: none expected.
5. **`SPAWN_CLEAR_COLS` made `pub`.** Alternative: duplicate in tests. Cost: a wider public API.
6. **Salt test is scoped to salts from 285 on** because of existing collisions (flagged: SALT_GEN_BIOME/SALT_MUD_MOVE
   share 260 and SALT_GEN_BIOME_R/SALT_SALT_DIAG share 261, possibly more). Fixing them would move every pinned world.
7. **House count at M is 1 and well count 1-2 per world at M/L;** the brief's `scale_count(w,h,3,1)` gives 1 at M.

## FUTURE.md ideas (lead decides)
- Give houses interiors (a table, a chest pickup, a ladder to the roof gap) so they are worth entering.
- A well-water bucket gameplay hook (draw Water into a bag).

## Commit 3: Houses: one door, the far wall grounds the roof (D-200)
Lead review: two 12-row doors cannot be grounded in a side view. Now one door on an rng side (draw index 4 of
SALT_GEN_HOUSE_RUIN, no new salt; a house within 60 columns of a world edge faces the centre). The far wall (both
columns) stands roof to floor, so roof, lintel and chimney are 4-connected to the ground. The roof gap takes only its top
row, so the lower roof row still joins the door-side lintel to the far wall. The broken outer column is on the door side.
`Structure` gained `door` (-1/+1, 0 for wells).
- `houses_stand_on_the_ground_and_never_float` is strict (flood region starts at `top - 8`, chimney included, no door-line
  exception). Red against commit bb2e997's code: "size 0 seed 1 false: house at 44 has a floating cell at 77,49".
- `houses_can_be_walked_through_and_entered`: one door of 12 Empty rows, far wall Brick to the floor, box flood reaches
  inside and both outer sides. Green.
- Side effects found: trunks must be 21 columns from a house (a canopy branch walled a door); shrubs and tufts beside the
  door made a 3-row obstacle under the lintel, so `clear_door_yards` removes plant cells more than 2 rows up within 8
  columns outside the door (a wider plant-exclusion zone starved size S of the greenery test's 10 plant columns).
- Pins moved: golden-v19.bin, `SCRIPTED_HASH = 10479313279286630864`, perf-trace, boss_gen non-survival hashes
  `[10839771303269676431, 10868778375382045356, 2810701790968458161]`. Only golden-v19.bin is in the index.
- Counts now: M houses 16/16 worlds, wells 16/16 (2 cave, 14 water); L houses 48, wells 16/16 (8 cave, 24 water).
