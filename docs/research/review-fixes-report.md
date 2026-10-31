# Review fixes report

## 1. Coal seams 3-5 cells thick (gen.rs place_coal)
Seam stamp changed from an L of 3 cells to a disc (radius 1 or 2 per seam, 3 or 5 wide). Rock only.
Coal cells at L, seeds 1-8, before: 4437 4532 4398 5861 5332 4838 5818 3783
After: 9857 9699 9800 12838 11927 10237 11657 8631
Gate: cargo test --release, clippy, typecheck, test:determinism (49 passed) all green.
No new test (existing gen tests incl. traversable_to_every_band cover it).

## 3b. gen.rs measurement test pickup bands
measure_gen_time_and_pickups now classifies deep pickups by membership in PICKUP_TABLE[1] instead of `spell < 4`. Landed in the item 1 commit (same file).

## 2. Acid and oil in small worlds (gen.rs)
Changes: oil floor 4 -> 6, acid floor 2 -> 3; oil tries 2000 -> 6000, acid tries 3000 -> 12000; acid sample window now starts at deep_top+20 (was lava_y_lo-40, which mostly sat above the acid's own deep_top+20 minimum, so small worlds wasted most tries).
Before (oil/acid cells, seeds 1-8) S: 20/146 27/0 59/0 114/0 50/0 99/0 24/341 0/0; M: 165/249 960/0 47/270 18/227 83/306 53/929 151/482 106/627.
After S and M: see the measure_f2_counts output summarised in the final reply; S acid is still 0 on seeds 2-6,8 because the acid band has no basin that is also 40+ cells from the path in a 512x512 world (tried 1-deep and 900-cap pools: still 0).
Side effect: the independent path test stays green. tests/enemy_worm.rs rock_arena counted global Rock and went red (379246 vs 379688) because a generated acid pool now sat near the arena and ate Rock; rock_arena now clears ACID first (the red run was the evidence).

## 3a. db.ts format label
SNAPSHOT_FORMAT_VERSION 3 -> 8 (snapshot.rs FORMAT_VERSION = 8), pinned by a new test.

## 4. client/room.ts
Q/E ignore e.repeat; the worker.ts Wall check uses SPELL_WALL (new in client/spells.ts, from SPELL_NAMES).

## 5. ENEMY_MAX_HP pinned
New test in tests/net/spells-table.test.ts compares worker.ts ENEMY_MAX_HP to ENEMY_STATS hp.
