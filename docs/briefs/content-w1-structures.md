# Brief content-W1: surface structures (ruined houses and wells)

**Model:** Sonnet. **Dollar cap: $14.** Read your spend at the start (S0) and after every commit:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
At S0 + $12 stop, commit only what is green, and finish the report. If the week reads **$366 or more**, stop at once.
**Tool-call cap: 120.** **Do not dispatch subagents.** Work only in `/tmp/wt-content` (branch `content`). Never touch
the main checkout (`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`), its :8080 server, `multa` or `main`.
**Do not push or merge.** Do not start servers or browsers (the lead does). Every `rm` names a literal absolute path
(never a variable, a glob on a variable, or a path relative to an earlier `cd`).

Read first: `CLAUDE.md` (sim invariants), `.claude/skills/run-tests/SKILL.md` (the gate and its rules), D-200 in
`docs/DECISIONS.md` (the mine stands on the ground), and in `sim/src/gen.rs`: `generate_world`, `place_trees`,
`canopy`, `plant_site`, `place_greenery`, `SPAWN_CLEAR_COLS`, `place_mine` (its footing and roof logic is the model to
copy), `box_reach`, `FIT_W`/`FIT_H`, `repair_traversal`; `Sim::spawn_point` in `sim/src/sim.rs`; `sim/tests/greenery.rs`
and `sim/tests/biomes.rs` (test patterns); `sim/src/rng.rs` (salts end at 284 on this branch: take 285 onwards,
grep `pub const SALT_` to confirm none collide). Look at worlds with
`cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo run --release --example dump_world -- SEED SIZE survival /tmp/cw1-SEED-SIZE.ppm`
and `magick /tmp/cw1-SEED-SIZE.ppm -crop ... /tmp/cw1-....png` (crop to the surface band; Read the PNG).

**Report as you go** to `/tmp/wt-content/docs/research/content-w1-report.md`: append after each commit (what landed,
each new test shown red and how, the commit hash, spend). It ends with **"Architectural decisions for review"** (what,
the alternatives, why, the cost later; when unsure take the more reversible option and flag it) and may suggest
FUTURE.md ideas (the lead decides).

## Files you may touch
`sim/src/gen.rs`, `sim/src/rng.rs` (new salts only), `sim/src/snapshot.rs` (the format bump and its doc line),
`sim/tests/*.rs` (new `sim/tests/structures.rs`, and the pinned values listed below), `sim/tests/fixtures/*`,
`server/db.ts` (`SNAPSHOT_FORMAT_VERSION` only), `sim/examples/dump_world.rs` (only if you need it), and your report.
Nothing else in `client/`, `server/` or `shared/`.

## What to build: `place_structures(g, seed, &surf, &trunks, &sc, arena)` in `gen.rs`

Called in `generate_world` **right after `place_trees` and before `place_greenery`** (so shrubs and tufts avoid the
structures by themselves: `plant_site` already needs bare Dirt with Empty above). Every world kind with Caves terrain
gets them (PvP and Survival; the sandbox has no generator). Integer only, no recursion, every random draw
`rng(seed, 0, k, j, SALT_GEN_<NEW>)` with a new salt per use, bounded tries. Return what was placed in a new field on
`World` (`pub structures: Vec<Structure>`, `Structure { kind: u8, x0: i32, x1: i32, top: i32, floor: i32 }` or
similar): it is generation output for tests only, never sim state (`Sim::new` ignores it; no snapshot layout change).

**Where a structure may stand (both kinds):** columns `x0..=x1` inside `40..w-40`; **every column outside the spawn
columns** (`|x - w/2| > SPAWN_CLEAR_COLS`) **and outside `ENEMY_SPAWN_CLEAR`** of the centre if the world is wide
enough (fall back to `SPAWN_CLEAR_COLS` only if no spot fits; say in the report which you did); no tree trunk within 6
columns (`trunks`); surface heights across the span within 4 rows of each other; solid Dirt under every column for at
least 3 rows (not an entrance shaft, not water); the whole box the structure will occupy above the ground is Empty (no
canopy, no branch). Structures keep at least 60 columns from each other. Nothing within `ARENA_KEEP_OUT` of the arena.

### 1. Ruined house (count `scale_count(w, h, 3, 1)`, tries x40)
- Width 26-40 columns, interior height 14-17 rows (a 5x10 body plus room to jump), walls **Brick** 2 columns thick.
- **Stand on the real ground** (D-200): the floor row is the highest ground in the span (`base = min surf`); each
  column whose ground is lower gets a Brick footing from `base` down to its ground (at most 4 rows, checked above).
  Never float: every Brick and Wood cell placed must be 4-connected through Brick/Wood to the footing or the ground.
- **A door on both sides**, each **12 rows tall** at floor level (the wall stands only above the door), so a body walks
  straight through along the surface. The surface must stay walkable end to end.
- **A broken roof**: 2 rows of **Wood** across the top on the walls, with one gap of 4-9 columns at an rng position
  (not over a wall); one wall's top is ruined (its upper 3-6 rows missing over a stretch). Optional, cheap touches
  if they look right in the dump: a Brick chimney 3 wide and 4-6 tall on the roof by one wall, one or two fallen Wood
  planks on the floor (2-4 cells, resting on the floor).
- Wood burns, so a ruin can catch fire. That is wanted; keep it bounded (a fixed amount of Wood per house).

### 2. Well (count `scale_count(w, h, 2, 1)`, tries x40)
- A shaft **7 columns wide** (a 5-wide body fits) with a **Brick** coping 2 columns thick each side, 3-4 rows above
  the ground, and a **Wood** frame: two 1-wide posts standing on the coping, 9-10 rows tall, joined by a 1-row Wood
  crossbeam over the shaft (a bucket line is a nice touch: 1 Wood cell under the beam's middle, or leave it).
- **Cave well (preferred):** dig the shaft down from the ground until its interior meets open cave (Empty) within
  `scale_u(h, 120)` rows; it becomes a second way down. Only if the cave it meets is a real region (the cell is
  reachable from the sky through the cave network after `connect_and_prune`, which ran before; a cheap test is that
  the open cell is part of a region of at least `MIN_REGION` cells; reuse `flood` with a bounded region if you can,
  otherwise accept it and say so) and is above `sc.deep_top`. Line the shaft walls with Brick for the first 8 rows
  below the ground, Rock/Dirt below that as it was. Never open into Lava, Acid, Gas or a pool's side: if the cells
  the shaft opens into (and the 3 rows below the opening) hold any liquid or gas, reject the spot.
- **Water well (fallback when no cave is in reach under that spot):** a shaft whose whole wall (one column either
  side) and floor are solid for its full depth, bottom row at `max(sc.shallow_top + 6, ground + 16)`, with Water
  filling the bottom 4-6 rows (it rests on solid: the existing liquids test pins water in the shallow band at
  `y >= SHALLOW_TOP`; keep to that).
- Choose cave versus water per spot, not per world; report the counts.

## Tests (new `sim/tests/structures.rs`; seeds 1..=8, sizes 0..=2, `caves_pvp` and `survival`)
Use `generate_world` on a fresh `Grid` (like `biomes.rs::make`) to get `World.structures`.
1. **They exist**: at sizes 1 and 2, at least one house in most worlds (assert >= 12 of the 16 per size; print the
   counts) and at least one well in at least half; state the numbers in the report. Size 0 may have none.
2. **Stand on the ground and never float**: every Brick/Wood cell inside a structure's box is 4-connected through
   non-Empty, non-liquid cells to Dirt/Rock below the floor row; every footing column ends on Dirt/Rock.
3. **Out of the spawn columns and the arena**: no structure column within `SPAWN_CLEAR_COLS` of `w/2`; no structure
   cell within `ARENA_KEEP_OUT` of the arena (`World.arena`); `Sim::spawn_point` still lands on Dirt/Rock with a clear
   box (the greenery test does this: keep it green unchanged).
4. **Walk through**: each house's two doors are 12 rows of Empty at floor level, and a body box (`FIT_W` x `FIT_H`
   or 5x10) fits standing inside the house; from the sky at the world centre, a box flood (reuse `box_reach` style,
   see `boss_gen.rs::reach`) reaches a standing spot on both sides of every house and inside it.
5. **Wells**: a cave well's shaft interior is Empty from the ground to its opening, and the opening cell is reachable
   by the sky flood; a water well's Water cells all have solid or Water under them and solid walls beside the shaft.
6. **Fire is bounded and sleep-invisible**: set one Fire cell on a house roof (directly in `grid.mat`, before any
   step, in a test only), step 1200 ticks with `sleep_enabled` true and false: the state hashes are equal; print the
   burned-cell count and assert all Fire is gone by tick 1200 or bounded (choose the assert from what you see; explain).
7. **Salts are unique**: if no test already pins unique salt values, add one that parses `sim/src/rng.rs` (or lists the
   constants) and asserts no two `SALT_*` share a value.
**Show each new test red first**: break what it guards (place a house over the spawn columns, lift the roof one row
so it floats, shut one door, drop a salt onto an existing value), run it, see the specific assertion fail, restore the
file from a copy (`cp` to `/tmp/cw1-*.rs.bak` first), and record the failing message in the report.
The existing generator tests must stay green **unchanged** (`every_open_cell_is_reachable_from_the_sky`,
`traversable_to_every_band`, `liquids_rest_on_something...`, `biomes.rs`, `greenery.rs`, `boss_gen.rs` reach tests,
`boss_choice.rs`' enemy-budget test: a large Survival world generates exactly `MAX_ENEMIES` = 64 today; state the
count after). If one fails, fix the generation, not the test.

## Pinned results (generation changes them on purpose)
- `FORMAT_VERSION` 18 -> **19** in `sim/src/snapshot.rs` (append "v19 (content-W1): new generation (surface ruins and
  wells); no layout change." to the doc comment), `server/db.ts` `SNAPSHOT_FORMAT_VERSION` 19, the `== 18` asserts in
  `sim/tests/bags.rs` and `sim/tests/heals.rs`, `golden.rs` (`git mv` the fixture to `golden-v19.bin`, regenerate with
  `HF_REGEN=1 ... --test golden -- --nocapture`, paste `SCRIPTED_HASH`), `perf_equiv` (`PERF_REGEN=1`; the sandbox
  scenarios must NOT move, game-world ones may), `boss_gen.rs` `non_survival_worlds_are_byte_for_byte_unchanged` (new
  hashes; extend its history comment). List which pins moved in the commit message.

## Commit checklist (one commit each; message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
- [ ] ruined houses + their tests (1-4, 6) + re-recorded pins + format 19
- [ ] wells + their tests (5) + re-recorded pins
- [ ] salt-uniqueness test (if needed) and the report finished

**Per commit** (repo root `/tmp/wt-content`, chained, logs to files, never piped, in the background, and wait):
`(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/cw1-cargo.log 2>&1) && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/cw1-clippy.log 2>&1) && pnpm typecheck > /tmp/cw1-tsc.log 2>&1 && git add <files by name> && git commit -q -F /tmp/cw1-msg.txt; echo "exit $?"`.
The lead runs the full gate (determinism and net) after you. Before any cargo run check
`pgrep -fl "cargo test|vitest|test:determinism|tests/soak"`; if another gate is running, wait for it. Iterate with
single test files (`cargo test --release --test structures`). Never commit red. Look at at least two seeds at M and L
in the dump (crop the surface band, Read the PNG) before the first commit, and say what you saw.
