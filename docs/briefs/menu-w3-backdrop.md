# Worker brief W3 (Sonnet): the backdrop: a living landscape with real mobs

You are a Sonnet worker for the menu redesign (lead brief: `docs/briefs/menu-redesign.md`, read "Backdrop" and
"Mobs in the backdrop"). Work only in `/tmp/wt-menu` (branch `menu-redesign`). Read `CLAUDE.md` there first,
especially the simulation invariants 1, 2, 9 and the input-cost rule. **Do not dispatch subagents.** Do not push or
merge; never touch `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`.

## Budget
Cap **$7**. Check at the start and every ~20 tool calls:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
At start + $7: stop, commit what is green, write the report.

## Report as you go
`/tmp/wt-menu/docs/research/menu-w3-report.md` after each commit: what landed, verification, perf numbers, spend,
**"Architectural decisions for review"** (choice, alternatives, why, later cost; reversible option when unsure,
flagged), `FUTURE.md` ideas (do not edit `FUTURE.md`).

## The approach (decided by the lead: option (a); do not switch to (b) or (c) without reporting why)
The lead measured this in Node (`/tmp/menu-probe/probe.ts`, `probe2.ts`: read them, reuse them):
- Enemies exist only in **Caves** worlds with `enemies: 1`, and step only inside a 448 x 256 cell rectangle around an
  **active, alive player** (`stepping_set`, `sim/src/enemy.rs`); chunks only update within 576 x 320 of one
  (`refresh_active`, `sim/src/sim.rs`). A spectator camera wakes nothing.
- The config `{ terrain: 0, size: 1, avatars: 1, damage: 0, spells: 0, brushes: 1, death: 0, respawnSecs: 0,
  pickupRespawn: 0, round: 0, maxPlayers: 8, enemies: 1 }` passes the sim's `decode` (no ABI change): 15-22 real
  enemies (slimes, imps, acid slimes, worms, wisps, frost sprites, one boss), generation 100-330 ms, a step 0.3-0.7 ms
  with one player. `damage: 0` means nothing hurts the explorer; `brushes: 1` lets the director paint.
- So the backdrop runs that world locally (the worker's existing `local` mode) with **one local explorer** (player 1:
  `Join`, then `Pos` from the worker's own avatar controller, exactly like the dev route `?world=game&avatar=1`).
  Slimes hop toward it, imps and wisps fly at it and spit fire bolts that set wood and moss alight. Every mob is a
  real sim entity drawn by the game's own `pushEnemy`; nothing is faked. Size **M** (1024 x 768), not S: the worker
  decides "game world" by `width() > 512` in local mode (`worker.ts` ~1066, 1077, 1188), and S would draw nothing.

## Build
1. **Config + worker hook (small, additive).** `client/protocol.ts`: `local.cfg` may be `"menu"`; a new message
   `{ type: "goto"; x: number; y: number }` (menu backdrop only: teleports the **local** controller in a **local**
   sim; the move reaches the sim as the controller's ordinary `Pos`, like `devgoto` does today; ignored when not
   `localSim`). `client/worker.ts`: `local.cfg === "menu"` inits from a `MENU_BACKDROP` config (define it in a new
   `client/menu/backdrop-config.ts`, **not** in `shared/`), joins the explorer (the existing `m.local.avatar` path),
   and never readies. Hide the white "me" chevron and the 3 px foot marker when the cfg is `"menu"` (a boolean set at
   init). Touch nothing else in `worker.ts`; keep the diff tiny and say in the report exactly what changed.
2. **Vignettes, found offline, never at runtime.** Invariant 9: nothing read from `entities()` may choose an input.
   So the explorer's teleport targets and the camera windows are **constants** in `backdrop-config.ts`: `seed` and a
   list of 3-4 vignettes `{ x, y, camX, camY }` (cells). Find them with a Node script under `tools/menu-vignettes.ts`
   (commit it): for seeds 1..300 at size M, score windows of 427 x 267 cells (the 1280 x 800 view at scale 3) by
   enemies inside (kinds weighted: fliers imp 1 / wisp 5 / frost 6 count double; the boss scores 0 because a boss
   on the menu reads as a spoiler: avoid windows containing kind 4 or 7), surface visible in the top third (sky +
   surface + the first caves: a cross-section "ant farm" landscape), and somewhere for the explorer to stand. Pick the
   best seed and its vignettes. Also prefer a seed whose sky (`applySky` in `worker.ts`, `SKY_KINDS` in
   `client/sky.ts`) is dawn, aurora or rain over plain night.
3. **The director** (`client/menu-preview.ts`, or move it to `client/menu/backdrop.ts` and keep `startMenuPreview`'s
   export): on each vignette, set the camera (`follow` off, `camera` with the vignette window), `goto` the explorer,
   then paint **small** landscape additions relative to the window with the existing pointer messages: a lava pool
   meeting a water trickle (rock and steam), sand pouring from a ledge into dunes, a gunpowder seam with a spark,
   rain or snow (material 27, Snow, now exists) from the sky edge, fire on a tree, moss. Stay within the sim's clamps
   (radius <= the brush max, strokes <= 120 cells; the current code already chunks strokes). Give the explorer
   life with scripted `keys` messages (walk left/right a few seconds each, jump now and then; symmetric so it stays
   near its spot). Rotate vignettes every ~25 s with the existing fade; restart the worker (fresh world) every 3-4
   vignettes so mobs that died in lava come back. Keep: hidden tab pauses (`pace`), reduced motion (the scene forms,
   then one still frame), phone variant (scale >= 2, 30 steps/s, fewer emitters).
4. **Guard test** `tests/net/menu-backdrop.test.ts` (Node, loads the built `sim/target/.../sim.wasm` like the probes):
   `MENU_BACKDROP` inits; each vignette window holds >= 3 enemies with at least one flier at tick 0 and no boss; after
   a `Join` + `Pos` at the vignette's explorer spot and 300 steps, >= 2 enemies in the window have moved. It catches a
   generator change silently emptying the menu. **Show it red first** (e.g. against a deliberately wrong seed or empty
   vignette list) and paste the failing summary in the report.

## Files you may touch
`client/menu-preview.ts` (or a move to `client/menu/backdrop.ts`), `client/menu/backdrop-config.ts`,
`client/protocol.ts` (additive only), `client/worker.ts` (the small hook above only), `client/menu.ts` **only** the
`startMenuBackdrop` function if the import path changes, `tools/menu-vignettes.ts`, `tests/net/menu-backdrop.test.ts`,
`client/menu.css` (only `.preview-bg`-style rules for the backdrop, appended at the end under a comment).
**Not**: `client/index.html`, `client/room.ts`, `client/slots.ts` (a parallel worker owns them), `sim/`, `shared/`,
`server/`. **No sim change of any kind.** If you find the approach needs one (a new input, a config field), stop and
report: that needs the user's sign-off.

## Commit checklist (one commit each; each message ends with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
1. [ ] `tools/menu-vignettes.ts` + `client/menu/backdrop-config.ts` (seed, vignettes) + the guard test (red, then green).
2. [ ] Protocol + worker hook (`"menu"` cfg, `goto`, chevron hidden).
3. [ ] The director: vignettes, landscape paints, explorer script, rotation, restart.
4. [ ] Perf + phone + reduced-motion pass, screenshots, report finalised.

## How to verify
- Before each commit, gated on the exit code (never `;`, never `| grep`):
  `cd /tmp/wt-menu && pnpm typecheck > /tmp/menu-w3-tsc.log 2>&1 && pnpm vitest run --config vitest.net.config.ts tests/net/menu-backdrop.test.ts tests/net/imports.test.ts > /tmp/menu-w3-net.log 2>&1 && git add <files by name> && git commit -q -F /tmp/menu-w3-msg.txt; echo "exit $?"`
  Commit 2 touches the worker: also run `tests/net/menu-room.test.ts tests/net/lockstep.test.ts` in that command.
- The wasm is already built; **do not rebuild it** (no `sim/` change). Look at it on the lead's check server: build
  `pnpm build:client:only > /tmp/menu-w3-build.log 2>&1`, then (re)start
  `PORT=8091 DATA_DIR=/tmp/menu-data node server/main.ts` from `/tmp/wt-menu` (kill the old one by its literal PID from
  `lsof -ti tcp:8091 -sTCP:LISTEN` first; never touch 8080), open `http://localhost:8091/` with agent-browser via
  `zsh -ic`, session `menuw3`, viewports 1280x800, 390x844, 844x390. Screenshot each vignette (wait ~8 s after it
  forms) to `docs/research/shots/menu-w3-*.png` (shrink with `sips -Z 1280`), **Read every png**, and iterate on what
  looks wrong: mobs too small to see, empty sky, the scene unreadable behind the panel, a muddy palette. Mobs are
  ~5-12 cells: at scale 3 they are 15-36 px, which should read; if they do not, raise the scale on desktop to 4.
- **Perf**: measure the worker's step time (`stats` messages already carry it; expose the last one on
  `window.__menuStats` from the menu side, read-only) and main-thread frame intervals, at 1280x800 and at 390x844 with
  **4x CPU throttle** (Playwright is a devDependency: `chromium.launch()`, `page.context().newCDPSession(page)`,
  `Emulation.setCPUThrottlingRate {rate: 4}`; write your script under `/tmp/menu-w3/`, not in the repo). Report step
  p50/p95 and frame p95 for both, against the old backdrop (`git stash` is not allowed: measure the old one first, on
  the build before your commit 3). Budget: step p95 under ~4 ms at 4x throttle on the phone viewport.
- At the end kill everything you started by literal PID, close the agent-browser session, remove `/tmp/menu-w3` by its
  literal path.

## Rules
- Invariants 1 and 9: the sim gets state only through inputs (Paint from the director's script, Join, Pos from the
  controller); nothing read from `entities()`, `events()` or the frame becomes an input or chooses one.
- An input must not cost unbounded work: every paint within the sim's clamps; the director's rate stays as now or lower.
- Every `rm` names a literal absolute path.
