# Brief SKYWORLD: the background is part of the world, not recomputed from live cells

You are a Sonnet worker. Read `CLAUDE.md` (invariants 1 and 9, the rm rule) and the `dev-tools` and `run-tests`
skills in `.claude/skills/` first. **Client-only**: no edits under `sim/`, `shared/`, `server/`.

## Budget and stopping
- Hard cap **$8**. Read spend at the start and every ~15 tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  Stop $8 above your start: commit WIP to your branch (never multa) and report. At most ~80 tool calls. No subagents.
- Write `docs/research/sky-from-world-report.md` **as you go**.

## Where
`git worktree add /tmp/wt-skyworld -b sky-from-world multa`; work only there. Build both wasms in the worktree before
vite (`pnpm build:sim && pnpm build:sim:devpaint`). Vite on 5190. Kill it by PID at the end. Never touch the user's
:8080 server or the main checkout.

## The bug (user's screenshot, 7 Nov, `/tmp/sky-bug2.png`: Read it)
On the surface, snow, ice, water, wood and a dug hole show the dark cave back wall **behind** them instead of the
sky, in blocky rectangles and vertical stripes. Cause: `Renderer.updateSurface` (`client/render.ts` ~305) recomputes
a per-column "ground line" from the **live** cells 5 times a second (first run of 3 solid cells; a shaft heuristic
over 64 columns). Anything solid the players add on the surface (snow piles, ice, painted walls, a rock that fell)
becomes "ground", so the sky stops there and the wall shows; digging changes it the other way. D-202 tried to patch
the heuristic; the user's decision (7 Nov) is that **the background should be part of the world**, fixed when the
world is generated, not derived dynamically.

## The job
1. **Capture the background once, from the generated world.** The worker calls `sim.init(seed, cfg)` (`client/worker.ts`
   `beginReplay` ~378, the local path ~1194) before any replay or snapshot restore, so right after init the grid is
   the pristine generated world. There, read `matView()` once and compute, per column, the generated ground line (the
   first solid terrain cell from the top; keep the D-202 rule of solid-and-not-plant, and decide whether to keep a
   simple version of the shaft rule for generated cave mouths: the generator's own shafts are part of the world, so
   the generated surface line is probably exactly right without it). Hand it to the renderer once (a new
   `Renderer.setBackground(groundY: Uint16Array)` or similar), upload it to the existing `uSurf` texture, and **delete
   the periodic `updateSurface` recomputation** and its rate limiting.
   - Every client generates the identical pristine world from (seed, cfg), so every client gets the identical
     background with no protocol change. A restored snapshot or a replayed log does not change it.
   - Check the menu backdrop (`client/menu-preview.ts`, local sim, a director painting scenes) and the sandbox (all sky,
     `uBands.x < 0.5`) still look right, and the room page's local dev path.
2. **The look stays as D-202 has it**: sky above the generated ground line of each column, the dim depth-band cave wall
   below it. The difference is only that the line never moves.
3. Whatever a player builds above the ground line now shows sky behind it; a hole dug into the earth shows cave
   wall, all the way to the surface: both are what the user wants. Say in the report if anything else looks odd.

## Verify
- `pnpm typecheck`; `pnpm test:net` (no sim change, so no cargo or determinism: say so). If you factor the ground-line
  computation into a pure function (do: e.g. `client/background.ts`), unit-test it in `tests/net/` with a tiny grid
  (a test that would fail if the line moved with a painted wall above the surface), shown red first against a version
  that reads live cells.
- **Look at it** (dev-tools skill), vite on 5190, `/game?world=game&avatar=1&cfg=survival&seed=2`, viewport 1280x800:
  reproduce the screenshot: `__devPaint` Snow (27), Ice (18), Rock (2) and Wood (6) blobs on the surface beside the
  spawn, and dig (Empty, 0) a hole into the dirt; screenshot before and after the fix and Read both. Also one deep cave
  and the menu at `/`. Save to `docs/research/shots/skyworld-*.png`.

## Commit checklist (on `sky-from-world`)
- [ ] the pure ground-line function + its test (red first)
- [ ] the renderer takes the background once from the generated world; `updateSurface` removed
- [ ] report + screenshots, and a D-row draft in the report (it supersedes D-202's dynamic line)
Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not push or merge.

## Report
What changed per file; before/after screenshots with one line each; **Architectural decisions for review** (where
the line is captured, what happens on a world reset or format change, the shaft rule kept or dropped); FUTURE.md ideas.
