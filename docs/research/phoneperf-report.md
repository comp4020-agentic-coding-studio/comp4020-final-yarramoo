# Track C report: phones and performance (8-9 Nov overnight)

Lead: Opus. Branch `phone-perf` from `multa` 6db70f7 (format 19). Worktree `/tmp/wt-phoneperf`, port 8082. **Client-only**:
nothing in `sim/`, `shared/`, `server/` or the protocol to the server changed (`client/protocol.ts` is the main thread to
worker message type only). No workers dispatched: every change was a few lines, cheaper done than briefed (CLAUDE.md).

## What the measurement found first

The 4x-throttled phone bench (below) showed the worker's frame **callback** (sim steps plus draw submission) at 8-20 ms
while frames arrived **0.4-1.1 s** apart. A DPR 1 run of the same menu ran ~8x faster (58 ms p50 against 500 ms). So
the cost on a phone is **fragment fill**, not the sim or JS: the world shader ran once per device pixel, about 3.2 M
pixels a frame for the 390 x 846 menu backdrop at DPR 3. D-210 had guessed "the cost is drawing"; this pins it to fill.

## Built

1. **One backing pixel per cell on touch devices** (`client/phone.ts` `backingSize`, used by `room.ts` `layout()` and
   `menu-preview.ts`). Every cell already draws as a flat block (whole-cell camera, every overlay rect rounded to whole
   cells, the shader colours by cell), so a 1:1 store scaled by CSS `image-rendering: pixelated` is the same picture.
   Desktop (fine pointer) is unchanged. Fill drops from ~3.2 M to ~37 K pixels (menu) and ~0.77 M to ~0.09 M (game).
2. **Menu backdrop draw cap 30 fps on phones and no draws behind settings, join and share** (`pace.drawMs`,
   `shouldDraw` in `worker.ts`, `coversBackdrop`). The sim keeps stepping by time owed, so the scene has moved on
   when a panel closes. The title and type picker stay live (the panel there leaves the scene visible).
3. **A taller camera window in portrait** (`gameView`, `PORTRAIT_VIEW` 288 x 312 on an upright touch screen; 480 x 270
   otherwise), and a touch canvas fills the stage with a fractional scale instead of flooring to a whole multiple.
   312 rows stay under the sim's 320-row active box (`ACTIVE_H`), so the view never shows frozen chunks at its edge
   (a test reads `sim/src/tuning.rs`); both sides divide by 2 and 3 so zoom stays whole. Rotating mid-game swaps the
   window and re-centres (`ResizeObserver`); checked in a two-browser room (phone + desktop): both live, 0 incidents.

## Cut

- **Floating left thumb-stick.** It changes the touch input path (`held` keys, pointer capture) the night before
  submission, and nothing measured it as a problem. Brief, ready: replace `tLeft`/`tRight` (`room.ts`, "On-screen
  movement buttons") with one pointer-captured zone on the left 40% of the stage; on `pointerdown` remember the origin,
  on `pointermove` set `touch-left`/`touch-right` in `held` when `dx` passes +-18 px and call `sendKeys()`; `dy < -30`
  sets `touch-up`; release clears all three. Same messages as today (`keys`), so invariants 1, 2 and 9 hold. Test:
  a pure `stickKeys(dx, dy)` in `client/phone.ts`, red first; then two browsers.
- **More rows than 312 in portrait.** Past `ACTIVE_H` = 320 the view would show unstepped chunks; more rows needs
  a taller active box, which is a sim change (cost per tick) and not client-only.

## Measurements (`tests/soak/phone-perf.ts`)

Headless Chromium, `isMobile`, touch, **DPR 3**, `Emulation.setCPUThrottlingRate{rate:4}` on the page during the
measured 12 s only, and the worker's rAF callback stretched 4x (CDP does not reach workers; n1.ts found the same).
GPU is SwiftShader, so fill shows up in the frame interval. "Frame" = the worker's rAF interval (what the player sees;
on the capped menu the draw runs on every other one). M Survival room, one player, after the descent.

| Scene | Viewport | Before p50 / p95 (ms) | After p50 / p95 (ms) |
|---|---|---|---|
| Menu (title) | 390x844 | 1017 / 1174 | 16.7 / 18.0 |
| Menu (settings) | 390x844 | 1230 / 2701 | 16.7 / 18.3 |
| Game | 390x844 | 467 / 817 | 24.9 / 32.4 |
| Menu (title) | 844x390 | 1116 / 1366 | 16.8 / 33.3 |
| Menu (settings) | 844x390 | 1017 / 1134 | 16.7 / 17.8 |
| Game | 844x390 | 234 / 416 | 35.2 / 45.0 |

Before: `/tmp/phoneperf-before.json` (load ~2-50 during the run: SwiftShader itself loads the machine; an earlier
before run read 416-567 ms for the menu, so the before column is "hundreds of ms to a second"). After:
`/tmp/phoneperf-after2.json` (menu) and `/tmp/phoneperf-after3.json` (game, with the portrait camera and fill).
Callback cost after: 0.6-1.8 ms p95-ish everywhere. Not measured: a real phone and a real GPU; the ratio of pixels
(~35x menu, ~8x game) is the portable part.

## Tests and gates

- `tests/net/phone-perf.test.ts` (13). Red first: the wiring checks failed before the wiring (`/tmp/phoneperf-red1.log`);
  the helpers failed when broken on purpose (`backingSize` returning the full size, `shouldDraw` without its slack
  drawing 20 fps not 30: `/tmp/phoneperf-red2.log`; `gameView` returning the base: `/tmp/phoneperf-red4.log`).
  The "portrait fill" check is a source pin only; the screenshot is its evidence.
- Batch 1 gate (`pnpm typecheck && pnpm test:net`, commit chained): first run **red**, 1 of 474:
  `claims-survival.test.ts` "timed out waiting for enemy kill resolved by majority" (`/tmp/phoneperf-g1-net.log`). Not
  this change: the test imports only `shared/` and `client/lockstep.ts` (untouched). Alone it failed 1 of 3 on this
  tree and passed 4 of 4 on clean multa, which does not separate them; the room seed is random per room
  (`server/main.ts` `seedForRoom`), so the scripted kill plays a different world each run. **A pre-existing
  intermittent for Track A**: pin the room seed in the test, or find the seed that fails. Rerun green, 474/474
  (`/tmp/phoneperf-g1b-net.log`), and committed on that exit code.
- Batch 2 gate: see the commit.

## Screenshots looked at

`/tmp/phoneperf-shots/`: `before-menu-390x844`, `after1-menu-390x844` (same picture at 1 px per cell), `before-` and
`after1-game-390x844` (thin strip), `after2-game-390x844` (288 x 312, integer scale left margins: fixed),
`after3-game-390x844` (fills the width) and `after3-game-844x390` (landscape unchanged), `before-menu-settings-390x844`
(the panel covers the scene), `rot-2-landscape` (phone rotated mid-game, both players drawn).

## Architectural decisions for review

1. **Touch devices render at one pixel per cell** rather than CSS x DPR. Alternatives: a DPR cap of 1 (still ~0.33 M
   pixels for the menu), or a `k`-per-cell store (k = 2 costs 4x). Why: the picture is per-cell already, so 1:1 loses
   nothing; it is the largest cut. Cost later: any future sub-cell drawing (smooth sprite motion, thin lines, text in
   the canvas) would be blocky on phones; such a feature would need `k > 1` on phones. Reversible in one place.
2. **Portrait view 288 x 312, bounded by `ACTIVE_H`.** A taller view needs a taller sim active box (cost per tick for
   every client). The view differs per client, which is fine: the camera is never an input (invariant 9).
3. **Fractional canvas scale on touch.** Uneven cell columns (4 or 5 device pixels at DPR 3) against margins. Desktop
   keeps whole multiples.
4. **The pause behind panels pauses drawing, not stepping** (`drawMs: -1`), so the backdrop does not freeze and jump.
   Stepping behind a panel still costs the sim (under 1.1 ms p95 per step, D-210).

## Spend

B0 $281.63. No workers. See the hand-back for the final figure.

## Drafts

- **D-218** | 2026-11-09 | **Phones draw one pixel per cell, the menu backdrop draws at most 30 fps and not behind
  full panels, and an upright phone shows a 288 x 312 view that fills the width** (`client/phone.ts`; client-only). |
  The 4x-throttled DPR 3 bench put the callback at 8-20 ms and frames at 0.4-1.1 s: fill, not the sim. | Sub-cell
  drawing would be blocky on phones; more than 312 rows needs a taller active box (sim). Not measured on real hardware.
- **Engineering decisions entry (draft)**: "Phones were slow because of pixels, not the simulation": the
  measurement (callback vs interval, the DPR 1 run), why per-cell drawing makes 1:1 free, and why the portrait view
  stops at the active box.
- **FUTURE.md (listed, not added)**: the floating thumb-stick (brief above); pin the Survival claims test's seed
  (Track A); a real-device measurement (Safari remote inspector) of these numbers.
