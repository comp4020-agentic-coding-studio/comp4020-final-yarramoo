# Brief biomes-2: the surface (hills, a lake, canopies, shrubs) and sand traps

**Model:** Sonnet. **Tool-call cap: 100.** Stop and write your report if you reach it.
**Work only in `/tmp/wt-biomes`** (branch `biomes`). Do not touch the main checkout, its :8080 server, `main` or `multa`.
**Do not push**: the lead re-runs the gate and pushes.

Read first: `CLAUDE.md` (sim invariants; `rm` only with literal absolute paths), `.claude/skills/run-tests/SKILL.md`,
`docs/biomes-plan.md` (sections 1, B1, B2, 4), `docs/research/biomes-w1-report.md` (what slice 1 built: the site
picker, `World.sites`, the dump_world tool), and in `sim/src/gen.rs`: `surface_heights`, `place_trees`,
`line_entrances_with_dirt`, `pick_entrances`, `carve_chambers`, the site picker, and `Sim::spawn_point` in `sim/src/sim.rs`.

**Report as you go** to `/tmp/wt-biomes/docs/research/biomes-w2-report.md`, appending after each commit. It ends with
**"Architectural decisions for review"** (what, alternatives, why, cost later; take the more reversible option when
unsure and flag it), and may list ideas for FUTURE.md.

## Files you may touch
`sim/src/gen.rs`, `sim/src/rng.rs` (new salts: take the next unused numbers after slice 1's), `sim/src/tuning.rs`,
`sim/tests/*.rs`, `sim/tests/fixtures/*`, and your report. Nothing in `client/`, `server/` or `shared/`.

## What to build

1. **Hills and a mountain.** Add to `surface_heights` one or two smooth hills (height 20-40 rows at L, half-width
   60-120 cols) and, on some seeds, one taller mountain (60-90 rows, half-width 120-180), as integer bump profiles
   (e.g. the checked-in `SMOOTH` table, or a parabola `h * (r*r - d*d) / (r*r)`), scaled with `surface_y / SURFACE_Y`
   like the existing amplitudes. **Keep every bump out of the spawn columns** (`|x - w/2| <= SPAWN_JITTER + 7*16 + 8`,
   see `spawn_point`) and away from the walls. The surface may not rise above row 40 at any size. Note the heightfield
   feeds the cave threshold and the entrance dirt, so caves under a hill start lower: check traversal still holds.
2. **Surface lake.** At most one per world, in a dip of the surface away from the spawn columns: dig a basin into the
   Dirt (half-width 25-50, depth 6-12 at L, shallower bowl edges) and fill it with Water, **only** where every basin
   cell's floor and both rims are solid Dirt/Rock for the whole column below to `surf + 20` (no entrance shaft or cave
   under it). If no spot qualifies in a bounded number of tries (say 64), skip it. Water must rest on solid (the
   existing liquids test).
3. **Canopies and shrubs.** Give each tree from `place_trees` a canopy: a rough blob (radius 5-8) of `STEM` with
   `aux = 0` (static green leaves, flammable, never grows) around the top of the trunk and the branch tips, only into
   Empty cells. Shrubs: 6-14 small mounds (2-4 tall, 3-7 wide) of `STEM` (aux 0) on flat Dirt, a few `FLOWER` cells on
   top, out of the spawn columns and not on the lake. Bound all counts with `scale_count`.
4. **Sand traps** (plan B2). Above a few roomy chambers or caverns in the shallow and deep bands (pick from slice 1's
   sites or `carve_chambers`' centres, bounded tries): find a ceiling point with at least 3 rows of solid above it,
   then replace a lens of Rock/Dirt (half-width 8-14, 4-8 rows thick) that starts 2-3 rows above the open ceiling
   with Sand, so a thin solid crust holds it. Rock and Dirt only, so no open space changes. Count `scale_count(w,h,10,3)`.
   Do not place one over the boss arena or within 60 cells of the spawn column. Sand in a sealed lens does not move
   until the crust breaks (the crust is structural Rock/Dirt; check how falling rock v0.5 treats a crust that holds
   sand: if the crust is a free island it might fall; anchor it by keeping its ends in the wall).

## Tests (in `sim/tests/biomes.rs`; seeds 1..=8, sizes 0..=2, caves_pvp and survival)
- no surface cell above row 40; the spawn columns' surface heights equal what `surface_heights` would give without the
  bumps (or simply: `spawn_point` still finds clear ground, and traversal still holds);
- at L and M, most worlds have a hill (assert on at least 6 of 8 seeds, state the counts you saw);
- the surface lake, where present, rests on solids and has no Empty below any of its cells; count lakes across seeds;
- canopy and shrub `STEM` cells all have `aux == 0`; counts bounded;
- each sand trap has solid crust between it and the open ceiling: no Sand cell of a trap is adjacent to Empty at
  generation time (except where `repair_traversal` cut through it, which the test may skip by checking only traps the
  repair did not touch, or by checking a count bound);
- existing traversal, reachability and `boss_gen.rs` tests stay green **unchanged**; if one fails, fix generation.
Show each new test red first (break what it guards, restore from a copy) and record that in the report.

## Pinned results
Generation moves `golden`, `perf_equiv` (game-world scenarios only; sandbox must not move) and
`non_survival_worlds_are_byte_for_byte_unchanged`. Re-record on purpose; list which scenarios moved.

## Commit checklist (one commit each; message ends with `Co-Authored-By: Claude Sonnet <noreply@anthropic.com>`)
- [ ] hills and mountain + tests + re-recorded pins
- [ ] surface lake + tests + pins
- [ ] canopies and shrubs + tests + pins
- [ ] sand traps + tests + pins
- [ ] report finished

**Per commit** (repo root, chained, logs to files, never piped):
`(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/b2-cargo.log 2>&1) && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/b2-clippy.log 2>&1) && pnpm typecheck > /tmp/b2-tsc.log 2>&1 && git add <files by name> && git commit -q -F /tmp/b2-msg.txt; echo "exit $?"`.
Before the last commit also chain `pnpm test:determinism > /tmp/b2-det.log 2>&1 && pnpm test:net > /tmp/b2-net.log 2>&1`.
Check `uptime` first; if load is above 16, wait. Iterate with single test files. Never commit red. Use
`cargo run --release --example dump_world` to look at worlds (write PPMs under `/tmp/b2-*.ppm`, convert with
`magick`, and Read the PNGs). Do not start servers. Every `rm` names a literal absolute path.
