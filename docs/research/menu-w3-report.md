# Menu W3 report: the backdrop (living landscape, real mobs)

Spend: start $134.82, end about $136.8 (about $2). Approach (a), as briefed.

## Commits
1. `tools/menu-vignettes.ts`, `client/menu/backdrop-config.ts`, `tests/net/menu-backdrop.test.ts`.
2. Protocol + worker hook (`"menu"` cfg, `goto`, markers hidden).
3. Director in `client/menu-preview.ts` (export `startMenuPreview` unchanged; `client/menu.ts` untouched).

## Guard test: red, then green
Red (enemies set to 0 in MENU_BACKDROP): `Tests 6 failed | 1 passed (7)`, e.g.
`AssertionError: window 0: 0 enemies, kinds []: expected 0 to be greater than or equal to 3`.
Also red on a wrong seed (seeds 5 and 8: 1 failed each; seeds 2 and 3 happen to pass, so the test is a floor, not a pin).
Green with seed 220: `Tests 7 passed (7)`. Gate for commit 2 also ran menu-room, lockstep and imports: 14 passed.

## Worker diff (commit 2), exactly
- `protocol.ts`: `local.cfg` doc mentions `menu`; new `{ type: "goto"; x; y }` message.
- `worker.ts`: import MENU_BACKDROP; `menuBackdrop` and `menuGoto` vars; `init` uses `encodeConfig(MENU_BACKDROP)` when cfg is "menu";
  `goto` case (local sim only; if the avatar is not built yet the target is applied when it is); chevron and foot marker skipped when `menuBackdrop`.
  The teleport reaches the sim as the controller's ordinary Pos.

## Seed and vignettes
Seed 220 (dawn sky), seeds 1..300 searched. Three windows: 8 mobs/5 fliers, 8/3, 4/2, no boss within 60 cells. Offline script also emits `skyY` (above the surface) and a tree-top for fire.
The brief's scoring needed two relaxations (stand-spot clearance counts liquid/solid, not "non-empty"; windows overlap allowed by 50%).

## Director
Per vignette (25 s, fade 1.3 s): camera, `goto`, scripted `keys` (walk/jump/walk back), emitters: lava+water trickle (rock, steam), sand pour + gunpowder seam + spark, snow + moss; fire on a tree. Radii <= 6, one stroke each (no multi-chunk strokes). After 3 vignettes a fresh worker (mobs that died return). Hidden tab pauses (`pace`), reduced motion: explorer still, emitters stop at 160 ticks then one frame (`pace`), phone: scale 3, 30 steps/s, thinner emitters. Scale is 3 (4 above 1920 px); mobs read well at 3 (screenshots).
`window.__menuStats` carries the last worker stats (read-only).

## Perf (headless Chromium, software GL, `/tmp/menu-w3/perf.mjs`, not committed)
| build | viewport | throttle | step p50 | step p95 | frame p50 / p95 |
|---|---|---|---|---|---|
| old | 1280x800 | 4x | 0.5 | 0.7 (max 1.0) | 167 / 367 ms |
| old | 390x844 | 4x | 0.3 | 0.5 (max 6.1) | 17 / 383 ms |
| new | 1280x800 | 4x | 0.7 | 0.9 (max 1.3) | 183 / 367 ms |
| new | 390x844 | 4x | 0.8 | 1.1 (max 6.9) | 167 / 450 ms |
| new | 1280x800 | 1x | 0.7 | 1.0 (max 7.0) | 183 / 350 ms |
Step p95 is well under the 4 ms budget. Frame intervals here (~170 ms) are SwiftShader software rendering of the full
page; the old backdrop shows the same at desktop, so it is the harness, not the change. On the phone the new scene is
heavier per frame (170 vs 17 ms p50, bigger world rendered at scale 3 with sky); treat it as unverified on a real
phone and measure there before merge. Worst case if it hurts: fall back to a fixed 30 fps frame cap in the worker for the menu.

## Screenshots (looked at all)
`docs/research/shots/menu-w3-desktop-s0.png` (vignette 0: lava/water falling, slimes, imps, a frost sprite), `-s3.png` (vignette 2: snow, dunes, mossy trees),
`-s4.png` (back to vignette 0 in a fresh world), `menu-w3-p0.png` (phone), `menu-w3-l0.png` (landscape).
Seen and fixed: first design had nothing visible; the panel hides the centre, so mobs sit left and right of it (the vignette windows are 427 cells wide so the sides carry them).
Not fixed: vignette 1 (sand/gunpowder) was not caught in a screenshot; on phones the portrait view is mostly panel, the scene shows at the top edge and bottom only.
Explorer is small (10 cells) and walks near the bottom of the screen.

## Architectural decisions for review
1. Config in `client/menu/backdrop-config.ts`, imported by the worker (a client file, not `shared/`). Alternative: `shared/room.ts` preset. Cost: none to the server; the config is not a named preset.
2. Constants for seed and vignettes, found offline (invariant 9). Cost: a generator change silently breaks them; the guard test covers enemies in windows but not the surface/explorer standing spot; rerun `node tools/menu-vignettes.ts 1 300`.
3. `goto` is a general worker message (local sim only). Alternative: a dev-only message. Reversible: delete the case.
4. Explorer is a real player (id 1) in a local sim with `damage: 0`; imps' bolts fly at it harmlessly.
5. World restarts after one round of 3 vignettes (`ROUNDS_PER_WORLD = 1`), which costs a 100-330 ms init and a worker reload every ~75 s.

## FUTURE.md ideas
- Menu backdrop could show the real server world's player-built things (a read-only snapshot of a live room).
- Cap the menu worker's draw rate on phones (30 fps) if real devices show jank.
