# Brief content-W3: per-biome cave back walls (client-only)

**Model:** Sonnet. **Dollar cap: $8.** Read spend at the start (S0) and after each commit:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
At S0 + $7 stop, commit only what is green, and finish the report. If the week reads **$366 or more**, stop at once.
**Tool-call cap: 80.** **Do not dispatch subagents.** Work only in `/tmp/wt-content` (branch `content`). Never touch the
main checkout (`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`), its :8080 server, `multa` or `main`.
**Do not push or merge.** Do not start servers or browsers (the lead looks). Every `rm` names a literal absolute path.

Read first: `CLAUDE.md` (invariants 1 and 9: this is drawing only, from the pristine generated grid, never an input),
D-211 in `docs/DECISIONS.md` (the background is part of the world, captured once after `sim.init`),
`client/background.ts` (`groundLine`), `client/render.ts` (the `FRAG` shader's cave-wall branch: "Below the line, a
cave's open cells show a dim back wall in the depth bands' colours"; `setBackground`, `setWorld`, the `surfTex`
texture on unit 2), `client/worker.ts` at the two `groundLine(...)` call sites, and `tests/net/background.test.ts`.

**Report as you go** to `/tmp/wt-content/docs/research/content-w3-report.md`; it ends with **"Architectural decisions
for review"** and may suggest FUTURE.md ideas.

## Files you may touch
`client/background.ts`, `client/render.ts`, `client/worker.ts` (the two backdrop call sites only),
`tests/net/background.test.ts`, your report. Nothing in `sim/`, `server/`, `shared/`.

## What to build
Today a cave's back wall is one function of depth (dirt brown, grey rock, cold blue-black). Make it read the biome:
**icy blue near ice, warm red-orange near lava, green near moss/mushroom (grotto), warm brown-amber near brick/wood
in the deep (mine)**. Nothing in the sim changes.

1. **A pure helper** in `client/background.ts`: `biomeTint(mat, w, h): Uint8Array` returning a coarse map of
   `Math.ceil(w/16) x Math.ceil(h/16)` tiles (one byte per tile: 0 none, 1 ice, 2 lava, 3 grotto, 4 mine) computed
   **once from the pristine generated grid** (same moment as `groundLine`). A tile's kind is the dominant biome
   material within a radius of about 2 tiles (count Ice 18 / Snow 27 for ice, Lava 14 for lava, Moss 23 / Mushroom 24
   for grotto, Brick 22 for mine, only below the ground line: pass `groundLine`'s result in so surface ruins of Brick
   and snow on the surface do not tint caves), with a minimum count so a lone cell does not tint. Bounded: one pass
   over the grid to count per tile, then a fixed-radius pass over tiles (no per-cell neighbourhood loops).
2. **The renderer**: a second R8UI texture (unit 3, `uTint`, size tiles) set by a new `setBiomeTint(tint, tw, th)`,
   allocated in `setWorld`. In the shader's cave-wall branch, sample the tint with a soft blend between neighbouring
   tiles (bilinear by hand from 4 `texelFetch`es, or `smoothstep` on the distance into the tile) and mix the wall
   colour toward the biome's colour at about 45-60% so it stays a dim backdrop well behind the terrain (keep the
   existing two-scale noise on top). Choose colours that sit behind each biome's materials: ice wall darker than Ice
   (palette 0xa8e4f0), lava wall a dark ember red that does not read as lava. Only below the ground line (the existing
   `else` branch), and only in game worlds (`uBands.x`).
3. **Worker**: call it at both `groundLine` sites right after `setBackground`.
4. **Tests** in `tests/net/background.test.ts` (red first: run each against a stub that returns all zeros, see it fail,
   record the message): ice cells under the ground line tint their tile 1; lava tints 2; a single stray cell does not
   tint; Brick above the ground line (a surface ruin) does not tint; the output length is `ceil(w/16)*ceil(h/16)`; a
   source guard that the shader samples `uTint` only in the below-ground branch. A timing probe on a 2048 x 1536
   array written to `/tmp/cw3-timing.txt` (not console.log); it should be well under 100 ms in Node.

## Commit checklist (message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
- [ ] `biomeTint` + tests (red first)
- [ ] renderer texture, shader branch, worker call sites
- [ ] report finished

**Per commit** (from `/tmp/wt-content`, chained, logs to files, never piped):
`pnpm typecheck > /tmp/cw3-tsc.log 2>&1 && pnpm vitest run --config vitest.net.config.ts tests/net/background.test.ts > /tmp/cw3-bg.log 2>&1 && git add <files by name> && git commit -q -F /tmp/cw3-msg.txt; echo "exit $?"`.
Before the last commit, also `pnpm test:net > /tmp/cw3-net.log 2>&1` (check `pgrep -fl "cargo test|vitest|test:determinism"` first and wait if another run is going). The lead looks at it in a browser.
