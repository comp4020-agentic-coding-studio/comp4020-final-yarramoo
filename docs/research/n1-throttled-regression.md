# N1 soak: the 4x-throttled client stopped keeping up (open, 7 Nov)

**Status: open.** Found overnight 6-7 Nov by the session model; no fix yet. Determinism is not affected.

## What
`pnpm soak:n1` could not run at all from 25 Oct (R3 made `/` the menu; the harness filled the old name field there).
With the entry fixed (`ad90989`, `/game`), a 10-minute run on `multa` passes every determinism criterion (0 incidents,
0 wire mismatches, every client on the same hash at the final checkpoint, 252/252 checked ticks agree) but fails
`throttledEndedLive` and `allClientsLiveAtEnd`: the 4x-throttled client ends **~16 900 ticks behind** (catching up for
119 of 120 samples). On 19 Oct (`docs/research/n1-30min.json`) it ended 38 behind.

## Bisect (3-minute N1 runs; good = throttled client < 300 ticks behind)
`git bisect` between `5dcda0c` (19 Oct, good: 19 behind) and `19b5b4f` (6 Nov, bad: 2 658) names **`51524fa`**
"Hotbar CSS: one row, opaque tiles, no clipping, scrolls on phones" (4 Nov). Rerun twice each, not noise:

| commit | run 1 | run 2 |
|---|---|---|
| `112eb71` (parent) | 37 behind, live | 33 behind, live |
| `51524fa` | 2 229 behind | 1 608 behind |

`51524fa` changes only CSS in `client/index.html`: `#spells` loses `pointer-events: none` (the bar now takes clicks),
becomes a full-width scrolling flex row, and `#stage.has-bar` gains `padding-bottom: 58px` (the canvas shrinks).

## Ruled out (probes on the current build, 1280x800, own server)
- **A resize loop**: one ResizeObserver callback per 20 s idle, throttled or not.
- **Idle throttled cost**: a 4x-throttled idle page steps 2 404 ticks in 20 s (live).
- **Bot-style clicking**: 20 random canvas clicks on a 4x-throttled page: live, 160 ticks/s, clicks ~235 ms.

## Not yet tried (what only the soak has)
The soak also wraps the worker's wasm `step()` to busy-wait 3x its own time, and puts every WebSocket frame through a
20-150 ms delay proxy; its bots also press keys (Q/E, digits) and dispatch key events on `window` after blurring the
join field. Next: rerun `51524fa` with (a) `pointer-events: none` restored on `#spells`, (b) the `padding-bottom`
removed, each alone, to find which property matters; then read what that changes in the soak's bot path.

## Why it matters
A real phone is roughly the throttled client. Phones now play (D-209), so this is worth closing before the showcase.
