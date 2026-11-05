# Mine floor fix (biomes branch)

## Red run (before the fix)
`cargo test --release --test biomes mine_beams_and_rooms_stand_on_the_ground_and_rooms_are_not_mostly_roof`:
`size 0 seed 2 sv false site 3: beam at x 160 rows 281..294 hangs over 14 (cell below 0)`.

## Fix (`place_mine`, `sim/src/gen.rs`)
- The floor is found per column with `find_floor` (a `Vec<Option<i32>>` over the hall width), not from `site_floor`.
- Rooms: width 20-36, height 18-20. The room slides along the hall from a random start (salts 110/130 + k, all
  `SALT_GEN_MINE`) to the first stretch where every column has ground within 6 rows of the highest, no spawn-clearance
  overlap, and the roof fits under the ceiling. Dips get a Brick footing; a roof-to-ceiling slit under 12 rows is
  bricked shut (it would be a stranded pocket). One 10-row door on a random side (salt 150 + k); the other wall runs
  to the floor.
- Beams: only where the hall is level (+-3) and open for 8 columns either side, at least 24 rows tall; they start 12
  rows under the roof (a walkway gap) and run to the ground. Platforms and the coal seam use the beams actually placed.
- The per-site fallback in `place_biome_halls` retries a mine without beams (room only) before undoing it, since
  a post can plug a way into a pocket.
- All decoration still overwrites Empty only. Integer only, counter-based rng.

## Test
`mine_beams_and_rooms_stand_on_the_ground_and_rooms_are_not_mostly_roof` (S/M/L, seeds 1-8, both presets): every
beam stands on ground, every room's columns reach ground through Empty/Brick only, interior columns do not hover,
the door is 10+ rows, the wall is 2+ rows, the interior is at least 6 wide. At least 1 in 5 mine sites gets a room
(19 of 79 do). It is not 100 %: many mine halls have a liquid lake (oil, water) or no level stretch for a floor, and
the rule is to place nothing there. The L brick floor assertion in the older test is now "at least half of the L
worlds have 40+ Brick" instead of every world.

## Pins moved
- `boss_gen` non-survival hashes (the generator changes every Caves world): the new values are in the file.
- `golden` SCRIPTED_HASH: unchanged (the golden world has no mine change). `golden-v14.bin` rewritten by HF_REGEN, same hash.
- `perf-trace.txt`: only `survival_l` lines moved (302 lines); sandbox scenarios did not move.

## Gen time at L
Native `dump_world`: 515-860 ms after (loaded machine), against 520-900 ms in the earlier report. About the same.

## Look
`docs/art/shots/biomes/mine-hall-fixed-L-seed2.png`: a Wood beam from a coal seam in the roof down to the hall floor.
Seed 1 L (not saved) shows a one-door Brick room on the floor. Most seeds show just a room or a beam: halls are sparse.

## Architectural decisions for review
- Placement rules are "place nothing rather than float": a mine on a lake floor stays bare. Cost: only about 1 in 4
  mine sites has a room. Alternative: dig or fill the floor; rejected as it alters traversal.
- Beams start 12 rows under the roof (a gap) so they do not split the hall. Cost: they do not touch the roof.
- Test thresholds (1 in 5 sites with a room, half of L worlds with brick) are loose on purpose; tighten if rooms
  are made more common.
