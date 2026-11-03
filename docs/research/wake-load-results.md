# Brief W load results (native, no cap on woken chunks)

Command: `cd sim && cargo run --release --example wake_load [1-5]`. Size-L Survival world (2048 x 1536, seed 1), one
player standing at the surface at x = 1024, 18000 ticks (5 minutes). The disturbance is applied at tick 600; every
statistic covers ticks 600-17999, so the baseline uses the same window. Single run each, on the dev laptop (noisy).
"Chunks run" is `ran_chunks` per tick; the active set is about 45 chunks, of which only the non-sleeping ones run.
"Woken" counts frozen (outside the 576 x 320 region) chunks with the woken bit set.

| # | Scenario | p50 ms | p95 ms | max ms | chunks run mean / peak | woken peak / mean | woken back to 0 |
|---|----------|-------:|-------:|-------:|-----------------------:|------------------:|-----------------|
| 1 | Baseline, no disturbance | 0.19 | 0.23 | 0.55 | 9.9 / 13 | 13 / 9.9 | never |
| 2 | Surface flood, 22 833 water cells | 0.95 | 1.11 | 3.38 | 28.3 / 43 | 34 / 20.1 | never |
| 3 | Fire beside 751 wood cells (the world has 1715 wood, no stems, flowers or seeds at the surface) | 0.22 | 0.27 | 3.60 | 10.2 / 40 | 16 / 9.9 | never |
| 4 | Lava, 265 cells, in a cave | 0.23 | 0.29 | 3.45 | 10.8 / 15 | 15 / 10.6 | never |
| 5 | Worst case: full-width water + lava sheets (12 096 cells each) | 1.31 | 1.68 | 9.14 | 56.8 / 106 | 86 / 44.2 | never |

Why "never back to 0": woken chunks that hold a free liquid surface, acid or lava stay woken because those cells
keep changing or are volatile (a water film's surface cells swap sides at random, in active chunks too). So a
chunk wakes and then stays awake for as long as it holds any such cell. The baseline shows it already: 10 woken
chunks on average with nothing disturbed, which are the generated pools, acid and lava next to the active region
that now run. Sand and powders do settle and re-freeze (test `woken_chunks_return_to_frozen_once_settled`).

## Browser estimate

The frame budget is 16.7 ms at 60 Hz, and the sim steps once per frame. Native vs wasm: `docs/research/g2-results.md`
has native bench 2.4 / 2.8 ms against Chromium P1 3.0 / 4.8 ms (p50 / p95; a different harness, so only a rough
guide), i.e. 1.25-1.7x. I did NOT measure a scenario in wasm. Taking 2x as a conservative ratio:
- p95 in every scenario is under 3.5 ms in a browser, about a fifth of the frame budget;
- the worst-case spike (scenario 5, max 9.1 ms native) is about 18 ms at 2x, one tick over budget, at the
  moment the sheets land; it is a spike, not a sustained rate (p95 1.7 ms);
- a slow phone (the 4x throttle used in G2) turns scenario 5's p95 into about 7 ms and its max into about 37 ms.

## Recommendation

No cap is needed on the evidence: even the deliberately unreasonable scenario 5 (a full-width lava and water
sheet) costs 1.7 ms p95. The cost is bounded by the grid in any case (each chunk runs at most once a tick, 1536
chunks). The cost to watch is the steady, un-settling one: chunks holding a free water surface never re-freeze, so
over a long session woken chunks can only accumulate, not drain. Two cheap options if that matters later (neither
built): (a) let a woken chunk freeze when its only activity is a liquid surface swap with no net change in a
window (needs a hash-visible rule); (b) cap woken chunks to a few hundred. Revisit if a real playtest shows a
sustained p95 above about 4 ms native.
