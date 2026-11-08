# Brief life-W3: grass on the surface and an ambient layer (client-only cosmetics)

**Model:** Sonnet. **Dollar cap: $3.5** (the lead's budget is nearly spent: be economical, read only what you need). Read your spend at the start and after every commit:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
If you are $3 over your starting figure, stop, commit what is green, finish the report. **Tool-call cap: 45.**
**Do not dispatch subagents.** Work only in `/tmp/wt-life` (branch `world-life`). Never touch the main checkout
(`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`), its :8080 server, `multa` or `main`. **Do not push.**
Do not start servers or browsers (the lead looks at it). Every `rm` names a literal absolute path.
**Nothing in `sim/`, `shared/` or `server/`.**

Read first: `CLAUDE.md` (invariants 1 and 9: nothing drawn may feed the sim), `client/render.ts` (the FRAG shader,
`uSurf` ground line, `uBands`, `uSky`, `hash`), `client/background.ts` (`groundLine`), `client/fx.ts` (`Particles`),
`client/worker.ts` `gameFrame` (~519) and the end of it (~1010, `fx.update`/`fx.toRects`), `applySky` (~371),
`skyReduced`. Material ids are in `shared/names.ts` (3 Dirt, 5 Water, 6 Wood, 8 Stem, 9 Flower, 23 Moss).

**Report as you go** to `/tmp/wt-life/docs/research/life-w3-report.md` (after each commit). It ends with
**"Architectural decisions for review"** (what, alternatives, why, cost later; take the reversible option when unsure).

## Files you may touch
`client/render.ts`, `client/fx.ts`, `client/worker.ts` (wiring only), a new `client/ambient.ts`, new or existing
`tests/net/*.test.ts` for what you add, and your report.

## What to build

1. **Grass in the shader** (`client/render.ts`, game worlds only: `uBands.x > 0.5`). A **Dirt cell (3) whose cell
   directly above is Empty (0), or a plant (8, 9), and which lies within ~6 rows of the generated ground line of its
   column** (`texelFetch(uSurf, ivec2(c.x,0),0).r`) draws as grass: the top 1-2 cells of such exposed dirt green
   (vary the green with `hash(c)`, e.g. between `vec3(0.27,0.55,0.18)` and `vec3(0.40,0.68,0.22)`), the cell below a
   darker transition. And an **Empty cell directly above such a grass cell** draws, for about 1 in 2 columns by hash,
   a grass blade (1 cell; 1 in 6 columns a 2-cell blade: check two cells down) mixed over the sky, swaying by
   shifting which columns show a blade a little with `sin(uTime*1.3 + c.x*0.2)` only when `uSky.y > 0.5` (reduced
   motion: static). Blades are drawn, not cells: avatars and the sim never see them. Keep the depth tint the dirt
   already gets below the surface. Cave dirt deeper than the ground line + 6 never grows grass.
2. **An ambient layer** (`client/ambient.ts`, a class with its **own** small particle pool, cap 120, so spells never
   lose particles to it; drawn into the same `rects` list from `gameFrame` before `fx.toRects`). Each frame it
   spawns at a bounded rate (at most ~3 per frame, `Math.random` is fine: cosmetic) **only inside the camera view**,
   by sampling a few random cells of `sim.matView()` in view (at most ~40 samples per frame, so cost is bounded):
   - **Falling leaves** under canopies: a sampled Stem (8) cell with Empty below, above the ground line: spawn a
     small green/yellow-green speck that drifts down slowly with a sideways sine wobble and fades (life 3-5 s).
   - **Butterflies** (honest decoration: the passive sim creature slice was cut for budget) by day/dawn (sky kind 1 or 2): a sampled Flower (9) on the surface: rarely (cap ~6 alive) spawn a
     2-cell butterfly (two coloured pixels, flapping by alternating 1 and 2 px wide) that flutters on a wandering
     path near where it spawned for 6-10 s.
   - **Fireflies** at night/aurora (sky kind 0 or 4) above the surface near plants, and **always** near Moss (23) or
     Mushroom (24) underground (the grotto): yellow-green 1-px glows that drift slowly and pulse alpha (cap ~25).
   - **Drips** from cave ceilings: a sampled Rock/Dirt cell below the ground line with Empty below it, near Water
     within a few cells (or 1 in 4 anyway): a 1-px pale blue drop that falls with gravity and vanishes after ~1.5 s
     or when it reaches a solid cell (read the mat view at its cell).
   Expose `setSky(kind)` and wire it from `applySky`. Under `skyReduced` spawn nothing (reduced motion).
   Nothing here reads entities or writes anything but `rects`.
3. **Shrub sway is out of scope** (plants are sim cells). Do not add sounds.

## Tests
- `tests/net/ambient.test.ts`: the pool never exceeds its cap after 10 000 updates on a synthetic grid full of
  flowers, stems, moss and ceilings; no spawn lands outside the given view rectangle; with reduced motion on, nothing
  spawns; fireflies only spawn for sky kinds 0/4 on the surface (and near Moss at any sky); a drip stops at a solid cell.
- `tests/net/background.test.ts` style **source guard** for the shader: the FRAG source contains the grass branch and
  it is gated on `uBands.x` (a regex over `client/render.ts`), so a refactor cannot silently drop it.
- `tests/net/imports.test.ts` must still pass (nothing in `server/`/`shared/` imports `client/`).
**Show each new test red first** (e.g. set the cap to 1000, remove the reduced-motion check), restore from a copy,
record it in the report.

## Commit checklist (message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
- [ ] grass shader + source guard test
- [ ] ambient layer + wiring + tests
- [ ] report finished

**Per commit** (repo root, chained, logs to files, never piped):
`pnpm typecheck > /tmp/w3-tsc.log 2>&1 && pnpm vitest run --config vitest.net.config.ts tests/net/ambient.test.ts tests/net/background.test.ts tests/net/imports.test.ts tests/net/fx-flash.test.ts > /tmp/w3-net.log 2>&1 && git add <files by name> && git commit -q -F /tmp/w3-msg.txt; echo "exit $?"`.
The lead looks at it in a browser and runs the full suites.
