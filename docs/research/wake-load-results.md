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

## Brief HR: a 30-minute session with repeated floods (4 Nov, provisional)

**30 minutes of simulated time** (108,000 ticks at 60 Hz), run natively as fast as the CPU allows: about 5 minutes
wall-clock. One scripted player, no browser, no wasm; floods are written into the grid in a single tick. It measures
how the woken-chunk count and per-tick cost grow with ticks and floods, not a real 30-minute session (memory, an
open tab, real players).

`cargo run --release --example wake_load 6`: size L, seed 1, one player walking 15 stops across the surface, a
200 x 30 flood beside them at every stop (every 2 minutes, water and lava alternating). **Run 1 shared the machine
with a worker's builds and tests, so its times are inflated;** a quiet rerun follows.

| Minutes | woken now | chunks run mean / peak | step p50 / p95 ms (native) |
|---|---|---|---|
| 1-2 | 8-9 | 21-25 / 57 | 0.8-1.1 / 1.2-2.4 |
| 7-8 | 56-74 | 73-78 / 100 | 3.0-3.6 / 5.7-8.6 |
| 15-16 | 60-64 | 78-92 / 121 | 2.8-3.2 / 3.6-4.5 |
| 21-26 (heaviest machine load) | 74-101 | 93-117 / 144 | 10.7-14.1 / 18-23 |
| 29-30 | 84-99 | 101-111 / 137 | 4.5-5.2 / 6.2-12.6 |

- **Woken chunks plateau, they don't grow without bound:** peak 119, then 80-100, of 1536. Each flood wakes a
  patch; part of it re-freezes as the water drains into caves, and the liquid that stays keeps its chunks awake.
- **The steady cost does cross the threshold this report set** ("revisit if sustained p95 above about 4 ms
  native"): the second half runs about 4x the chunks of the first, with p95 6-12 ms even setting aside the
  loaded minutes. At the 2x wasm ratio above that is 12-24 ms in a browser, at or over the 16.7 ms frame.
- Not decided here: D-176 (no cap) is the user's call. See the quiet rerun below for the numbers to decide on.

### Quiet rerun (nothing else running)

Chunk counts are identical to run 1, tick for tick (the sim is deterministic), so only the times differ: run 1's
were the machine's load, not the sim.

| Minutes | woken now | chunks run mean / peak | step p50 / p95 ms (native) | max ms |
|---|---|---|---|---|
| 1-6 | 8-31 | 21-45 / 72 | 0.5-1.2 / 0.7-1.6 | 2-4 |
| 7-12 | 52-74 | 68-93 / 122 | 1.9-2.5 / 2.7-4.5 | 11-113 (the tick a flood lands) |
| 13-18 | 60-65 | 73-92 / 121 | 2.2-2.9 / 2.7-3.7 | 4-11 |
| 19-24 | 70-101 | 87-117 / 144 | 3.1-3.8 / 4.2-4.8 | 6-69 |
| 25-30 | 81-99 | 93-111 / 143 | 3.0-3.6 / 3.7-4.6 | 6-71 |

**Reading.** After 15 floods in 30 minutes, the steady cost is about 3.3 ms p50 and 4.4 ms p95 native, right on the
"about 4 ms" revisit line, not far past it. At the 2x wasm ratio that is about 9 ms p95 in a browser, half the 16.7 ms
frame; a phone at 4x throttle would be at or over it. The spikes (up to about 110 ms native) are the tick a 6000-cell
flood is dropped in, which this scenario does by writing cells directly; a real flood arrives over many ticks.
Woken chunks plateau near 100 of 1536 rather than growing without bound. **Whether to act is the user's call
(D-176).** The cheapest options, unchanged: let surface shimmer freeze, step woken chunks every second tick, or a cap.
