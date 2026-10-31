# Review fixes report

## 1. Coal seams 3-5 cells thick (gen.rs place_coal)
Seam stamp changed from an L of 3 cells to a disc (radius 1 or 2 per seam, 3 or 5 wide). Rock only.
Coal cells at L, seeds 1-8, before: 4437 4532 4398 5861 5332 4838 5818 3783
After: 9857 9699 9800 12838 11927 10237 11657 8631
Gate: cargo test --release, clippy, typecheck, test:determinism (49 passed) all green.
No new test (existing gen tests incl. traversable_to_every_band cover it).

## 3b. gen.rs measurement test pickup bands
measure_gen_time_and_pickups now classifies deep pickups by membership in PICKUP_TABLE[1] instead of `spell < 4`. Landed in the item 1 commit (same file).
