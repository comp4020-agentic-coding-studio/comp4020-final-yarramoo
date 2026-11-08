# SKYWORLD report: the background is part of the world

Branch `sky-from-world` (worktree /tmp/wt-skyworld). Client-only; spend about $0.4 of the $8 cap.

## Changes
- `client/background.ts` (new): pure `groundLine(mat, w, h)`. D-202 rule (first run of 3 solid non-plant cells) plus the shaft rim rule, run once over the whole width.
- `client/render.ts`: `updateSurface`, its rate limit, window tracking and the GROUND/PLANTS/SHAFT constants are gone. New `setBackground(groundY)` uploads the line to the `uSurf` texture once.
- `client/worker.ts`: right after `sim.init` (in `beginReplay`, and the local dev/menu path) the pristine grid is read and handed to `setBackground`.
- `tests/net/background.test.ts`: pure function tests plus a source guard that render.ts has no `updateSurface`/`GROUND[`.

## Tests
- `pnpm typecheck` clean. `pnpm test:net` exit 0, log /tmp/skyworld-testnet.log. No sim change, so no cargo or determinism run.
- Red first: the "captured once" test asserts that a live recomputation after painting snow gives 8 while the captured line stays 20, which is the bug itself; the renderer guard failed against the old render.ts (2 of 5 failed before the render change).

## Screenshots (docs/research/shots/)
- `skyworld-before.png`: old code, floating ice/wood painted above the surface: dark blocky cave-wall columns behind them (the user's bug).
- `skyworld-after.png`: same paints (plus snow, a dug hole): sky behind all of it, the hole shows cave wall to the surface.
- `skyworld-menu.png`: menu backdrop unchanged, sky above the surface, wall below.
- Not captured: a deep-cave shot (my camera hook call did not move the view; deep caves are below the line and use the unchanged wall shader). Sandbox is untouched (`uBands.x < 0.5` still all sky); setBackground is only called for cave worlds.

## Odd things
- A snapshot restore or replay cannot change the line (taken before either). In a real room a client taking a late-join path goes through `beginReplay`, so it too generates a pristine world first.
- Terrain the generator never made (e.g. a player's stone bridge over a generated chasm) correctly shows sky, but a cave mouth carved after generation shows sky, not wall, below the old line only if it opens above the line; digging below shows wall. Fine.

## Architectural decisions for review
1. Capture point: worker, right after `sim.init`, before replay/restore. Alternative: send from the sim (needs ABI change, rejected: client-only). Cost: costs one pass of w*h/... only over columns, ~0 per frame.
2. World reset / format change: both go through `beginReplay`, which re-inits, so the line is recaptured automatically; nothing is cached across worlds.
3. Shaft rule kept (cheap, now one-off) so generated cave mouths still read as wall. Could be dropped if the generator's mouths look wrong; unverified.

## D-row draft
D-211: The backdrop line is captured once from the generated world (client/background.ts, `Renderer.setBackground`), never recomputed from live cells. Supersedes D-202's dynamic line (its rules are kept, only the periodic recompute is removed).

## FUTURE
- Store the line in the world snapshot or generator output so mid-game re-gens are impossible to disagree on.
