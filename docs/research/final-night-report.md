# Final night (9 Nov 2026): fixes, merge to main, deploy

Lead: Opus, handed the run by the session model. Budget $35 for the night (week read $415.64 at the start; stop
starting work at $455).

## Morning summary

(Filled in at the end.)

## Brief

1. Two bugs from the user's screenshots: (a) lava levels left more easily than right; (b) a dark cave-wall block
   above the surface at a hill. Red test first, gate, merge to `multa`.
2. M4 (`layouts`) only if its report says done, green, cold-reviewed.
3. Docs: PROCESS (admin dashboard pointer), ARCHITECTURE refresh, DECISIONS/FUTURE rows.
4. PR `multa` -> `main`, CI green, merge (authorised by the user), watch the deploy.
5. Check the live site in a browser. 6. Preflight.

## Running notes

### 1a. Lava bias (D-233)

- Diagnosis confirmed: `update_lava` moved only on `tick & 1 == 0`, and even ticks always scan rows left to right.
- Red: `lava_levels_the_same_from_either_wall` (the existing right-wall column and its mirror against the left wall):
  left wall spanned 46 rows, right wall 1 (6000 ticks). Fix: `tick & 2 == 0`. After the fix both read 3 at 6000
  ticks (level, rippling) and within 2 at 12000; with 12000 ticks the old code is still red (13 vs 1).
- `lava_heap_levels_in_the_sandbox` (determinism.rs) read 3 at 16000; a probe every 2000 ticks: 21, 14, 8, 4, 3,
  3, 3, 3, then 2 from 18000 and 1 from 34000. Run extended to 20000, bound kept at 2.
- Snow: probe pile from one point, extents 38 left / 38 right: no bias, left alone.
- Pins moved (all lava scenarios): golden snapshot + `SCRIPTED_HASH`; perf_equiv `lava_water`, `bomb`,
  `creative_m_spells`, `mixed_sleep_on`, `mixed_sleep_off`. Unmoved: `sand_pour`, `water_flood`, `fire_wood`,
  `survival_l`. No snapshot format bump.

### 1b. Background block in the sky (D-234)

- Not what the brief guessed (ground line above the surface at a cave mouth because of a material): it is the shaft
  rule itself. The rim per side was the highest ground within 64 columns, and only columns more than 12 below it
  closed, so the wall ended in a vertical edge over open funnel cells up to 12 rows lower, its top at the hill's
  height. Probe (`/tmp/fn-bg/probe3.ts`, 31 worlds: the menu backdrop and Survival S/M/L seeds 1-10): 183 of 190
  closed spans had that step.
- Fix: the rim is the highest row where the open run around the column is still at most 40 wide (and not open to
  the world edge); the whole run closes there. Probe after: 0 steps, all 801 deep-shaft columns still closed. Width
  sweep: 16 left 251 shaft columns open, 24 left 52, 32 and up left 0; 40 chosen for margin.
- Red first: two new tests in `tests/net/background.test.ts` failed on the old rule ("wall at x=65 (row 42) ends over
  open air at x=64 (line 54, ground 54)"; a wide valley filled to 56 instead of 70); 9/9 green after.
- Screenshots (vite dev route, Survival M seed 1, `__setCam(180, 20)`; "before" from a detached worktree at
  `059d75a`): [`bg-before.png`](shots/final-night/bg-before.png) shows both shaft mouths topped by a block of cave
  wall standing above the grass with a vertical edge in the sky; [`bg-after.png`](shots/final-night/bg-after.png)
  closes both flush with the terrain lip.

### Gate (D-233 + D-234 together)

Full tier, chained on exit codes (`/tmp/fn-gate.sh`), queued behind the M4 lead's gate (one at a time): cargo green,
clippy clean, typecheck clean, determinism 53/53, net 561/561. Committed `cba41a1` (D-233), `118d5b4` (D-234).
