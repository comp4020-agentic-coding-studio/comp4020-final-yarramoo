# Brief biomes-2: Brick, Moss, Mushroom; the grotto and the old mine; ice floors; generation time

**Model:** Sonnet. **Tool-call cap: 100.** Stop and write your report if you reach it.
**Work only in `/tmp/wt-biomes`** (branch `biomes`). Do not touch the main checkout, its :8080 server, `main` or `multa`.
**Do not push**: the lead re-runs the gate and pushes.

Read first: `CLAUDE.md` (sim invariants: no floats, no HashMap, counter-based rng, **sleeping must be invisible**,
bounded work; `rm` only with literal absolute paths), `.claude/skills/run-tests/SKILL.md`, `docs/biomes-plan.md`
(sections 1, C1, C2, 4), `docs/research/biomes-w1-report.md` (the site picker, `World.sites`, `BIOME_*` constants,
`carve_sites`/`seal_site`/`fill_lava_lakes`, dump_world), and `docs/engineering-decisions.md` entry 27 (the half of the game that did not know
about six new materials: follow every place a material id is listed).

**Follow Pebbles (id 21) end to end**: `git grep -n -i pebble -- ':!deprecated' ':!docs' ':!research'` lists every
place a material is known: `sim/src/materials.rs` (id, `paintable`, `is_flammable`, `material_class`), `sim/src/grid.rs`
(`is_structural`, `dissolvable`, the dig and explosion match arms, the update dispatch), `shared/names.ts`
(`MATERIAL_NAMES`, `isPaintable`, `MATERIAL_CLASS`), `client/materials.ts` (`MATERIALS` hotbar entries for paintable
ids, `paletteTable` for the rest), `sim/tests/enemy_ai.rs` `material_classes_match_names_ts` (count 22),
`tests/net/avatar.test.ts` (class pin list), `sim/src/input.rs` (fill-empty bit comment), `sim/tests/pebbles.rs` and
`sim/src/grid.rs` paintable test (`PEBBLES + 1` is assumed unpaintable: update it), and `sim/examples/dump_world.rs`.

**Report as you go** to `/tmp/wt-biomes/docs/research/biomes-w2-report.md`, appending after each commit; it ends with
**"Architectural decisions for review"**, and may list ideas for FUTURE.md.

## Files you may touch
`sim/src/materials.rs`, `sim/src/grid.rs`, `sim/src/gen.rs`, `sim/src/rng.rs` (next unused salts), `sim/src/tuning.rs`,
`sim/tests/*.rs`, `sim/tests/fixtures/*`, `sim/examples/dump_world.rs`, `shared/names.ts`, `client/materials.ts`,
`tests/net/avatar.test.ts`, `tests/net/*.test.ts` only where a material count or paint range is pinned, your report.


## Two fixes to slice 1 (do these first)
- **Generation time.** At L, native gen went from 270 ms (multa) to 691 ms (`cargo test --release --lib
  measure_gen_time -- --ignored`, writes `/tmp/f1-gen.txt`). The cause is whole-grid `box_reach` and `flood` passes run
  once or twice per site in `carve_sites`, `seal_site` and `fill_lava_lakes`. Bring L back under about 400 ms without
  changing what the checks guarantee: e.g. compute the walkable depth once before the site loop and recompute only
  after a change that could reduce it, run `seal_site`'s floods once for all sites (dam every site, flood once, undo
  only the dams whose cells border a stranded region larger than `DAM_STRAND_MAX`), or bound the flood to the site's
  neighbourhood where that is provably equivalent. If a change alters the generated worlds, that is acceptable (re-record
  pins in the same commit) but the existing traversal, reachability and arena tests must stay green unchanged. Report
  before/after times at S, M, L.
- **Ice floors you can slide on.** An ice cave now has a one-cell lining and a small lidded pool; the user asked for
  "frozen lakes; walking on ice slides". Make the cavern's floor solid Ice 2-3 rows deep across its whole width (the
  flat floor row from `site_floor` and the row below, Rock/Dirt -> Ice), keep the lidded pool, and make the lid reach the
  shore where the pool stays joined to open cave some other way (the reason it stopped 3 columns short). Still `aux = 1`.
  Extend the ice test: each ice site has at least N Ice cells on its floor row (pick N from measurement).

## Materials (ids are fixed; colours are suggestions)
- **BRICK = 22.** Inert static solid. Structural (`is_structural`: it anchors and forms islands like Rock). Cleared by
  Dig and explosions like Rock. **Not** dissolved by acid (that is its point). Not flammable. Paintable. Colour
  `0x9a4a36`, name "Brick".
- **MOSS = 23.** Static solid, **not structural** (like a plant: a moss patch never anchors or forms a falling island).
  Flammable, slowly: in `update_fire` the ignite chance is 1 in 40 (Wood is 12). Lava ignites it like other flammables.
  Acid dissolves it; Dig and explosions clear it. Paintable. Colour `0x4f7a2a`, name "Moss".
- **MUSHROOM = 24.** Static solid, not structural, flammable 1 in 6, dissolvable, cleared by Dig and explosions,
  paintable. Colour `0xb85a8c` (a cap colour; stalks are existing Stem), name "Mushroom".
Neither new solid needs an update rule (static, like Brick): add nothing to the dispatch, so they are never volatile
and sleeping cannot see them. `is_flammable` gains MOSS and MUSHROOM; check every caller (fire lingering on fuel,
lava's volatility test) still means what it says. `paintable` gains 22-24: keep the fill-empty bit (bit 7) clear.
Hotbar: append the three to `MATERIALS` in `client/materials.ts`.

## Generation
Add `BIOME_GROTTO = 3` and `BIOME_MINE = 4` to the site picker (depth bands in the plan; counts
`scale_count(w,h,3,1)` each, radii like slice 1's ice caverns: rx about 45-70, ry rx / 2), carving their caverns the
same way slice 1 did (before `connect_and_prune`). Then, after the liquids and before `clear_arena`/`repair_traversal`:
- **Grotto:** the cavern's Rock/Dirt lining (cells in the ellipse grown by 4 that touch Empty) becomes Moss about 3 in
  4; 3-6 giant mushrooms on the floor where there is headroom (a Stem stalk with `aux = 0`, 1-2 wide, 6-14 tall, and a
  Mushroom cap dome, half-width 4-8, 3-5 rows, into Empty only); some floor-moss tufts 1-2 tall. A marsh-gas pocket
  under the cavern roof if the existing `place_gas_pockets` rules (open height, lava distance) allow; reuse its logic.
- **Mine:** 3-6 vertical Wood beams (2 wide) from floor to ceiling across the hall, a Wood platform (1-2 rows thick)
  between some beam pairs at mid height leaving at least 12 rows of headroom under it and gaps at the ends so it does
  not seal the hall; one or two Brick rooms on the floor (outer 20-36 wide, 12-16 tall, walls 2 thick, a 10-tall door
  gap on each side, Brick floor-to-roof only into Empty); one coal seam forced through a wall cell next to a beam
  (Rock -> Coal, like `place_coal`); a small gunpowder pile (≈20-40 cells) in a room, honouring the lava keep-away.
  Everything writes only into Empty (beams, platforms, rooms) or replaces Rock/Dirt (coal, lining), so a body's path
  through the hall stays open; `repair_traversal` remains the backstop.
- Pickups and enemies are placed later on the final grid by the unchanged band rules (no change needed); check they do
  not spawn inside brick walls (they need Empty, so they cannot).

## Tests
- Material unit tests (new `sim/tests/biome_materials.rs`): ids and rules pinned (structural/flammable/paintable/class
  for 22-24); moss next to fire ignites on average much more slowly than wood (count ignitions over a fixed number of
  ticks in a scripted grid, a fixed seed, and assert a ratio); acid next to brick leaves it, next to moss eats it; Dig
  clears brick; painting each new id works and fill-empty does not overwrite them.
- **Sleep on/off identical (D7)**: extend `sim/tests/sleep.rs`'s sandbox script (or add a script) with brick, moss and
  mushroom painted, then fire set to the moss and mushroom; the existing `same()` harness.
- Generation (in `sim/tests/biomes.rs`, seeds 1..=8, sizes 0..=2, caves_pvp and survival): every L and M world has a
  grotto and a mine (state S counts); Moss, Mushroom, Brick and the mine's Wood counts bounded; no Brick/Moss inside the
  arena (grown by `ARENA_KEEP_OUT`) or in the spawn clearance; existing traversal, reachability, `boss_gen.rs`, and
  `acid_stays_off_the_path_and_gen_materials_are_paintable` (all generated materials paintable or Bedrock) stay green.
- The class pin tests (`material_classes_match_names_ts`, the avatar class test) count 25 ids.
Show each new test red first and record it.

## Pinned results
Generation moves `golden`, `perf_equiv` game scenarios and `non_survival_worlds_are_byte_for_byte_unchanged`; sandbox
scenarios must not move (no existing rule changes). Re-record on purpose; list what moved.

## Commit checklist (message ends with `Co-Authored-By: Claude Sonnet <noreply@anthropic.com>`)
- [ ] generation time fix + before/after numbers + pins if moved
- [ ] ice floors + test + pins
- [ ] the three materials end to end (sim rules, names, classes, colours, hotbar) + material tests + sleep test
- [ ] grotto generation + tests + pins
- [ ] mine generation + tests + pins
- [ ] report finished

**Per commit** (repo root, chained, logs to files, never piped):
`(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/b2-cargo.log 2>&1) && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/b2-clippy.log 2>&1) && pnpm typecheck > /tmp/b2-tsc.log 2>&1 && git add <files by name> && git commit -q -F /tmp/b2-msg.txt; echo "exit $?"`.
The materials commit and the last commit also chain `pnpm test:determinism > /tmp/b2-det.log 2>&1 && pnpm test:net > /tmp/b2-net.log 2>&1`.
Check `uptime` first; if load is above 16, wait. Iterate with single test files. Never commit red. Look at worlds with
dump_world (PPMs under `/tmp/b2-*.ppm`, `magick` to PNG, Read them). Do not start servers. Every `rm` names a literal
absolute path.
