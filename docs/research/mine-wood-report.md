# Mine wood report (branch mine-wood)

Test: sim/tests/mine_wood.rs (seeds 1-32, Survival, worlds with >=2 standing beams >=8 rows; threshold 75%).

| size | worlds | with mine | >=2 beams before | beams before | >=2 beams after | beams after |
|---|---|---|---|---|---|---|
| M | 32 | 32 | 1 (3%) | 2 | 25 (78%) | 166 (5.2/mine) |
| L | 32 | 32 | 4 (12%) | 8 | 32 (100%) | 628 (19.6/mine) |

Changes (sim/src/gen.rs, generation only, no FORMAT_VERSION bump):
- `mine_floor`: beams use their own floor scan reaching 4*ry+40 rows below the hall centre; ground = Rock/Dirt/Bedrock/Sand/Brick/Coal/Moss. A liquid film, Ice and Pebbles are not ground (None): no post in a puddle or on a slick.
- Rooms keep the old shallow floor model (the room tests pin that shape).
- `open`: +-6 rows level (was 3), roof within +4 (was 2), checked on 10 columns (was 18): at least 5 with floor, the 4 nearest all fine; step limit 5; min clear height 19 (was 24); beam spacing 6 (was 14); candidate pool 40 per beam (was 6).
- Platforms skip room spans and stay 12 rows under the roof (found by gate: boss_gen arena unreachable at size 2 seed 7).
Pins re-recorded: golden-v14.bin, SCRIPTED_HASH unchanged, perf-trace.txt, boss_gen non-survival hashes.
Undo (place_biome_halls whole-site undo): measured mid-way at 17-21 fires over 64 worlds with the narrower open test, 0 fires with the final thresholds (before the room-model and platform tweaks; not re-measured after). The undo is untouched.
Not done: browser screenshots (tool budget); no scaffold fallback was needed.
Gate: exit 0, logs /tmp/g-cargo.log, g-clippy.log, g-tsc.log, g-det.log, g-net.log.
