# Brief biomes-1: site picker, format 14, lava lakes, ice caves, ice sliding

**Model:** Sonnet. **Tool-call cap: 100.** Stop and write your report if you reach it.
**Work only in `/tmp/wt-biomes`** (branch `biomes`). Do not touch `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`,
its :8080 server, `main` or `multa`. **Do not push**: the lead re-runs the gate and pushes.

Read first: `CLAUDE.md` (sim invariants: no floats, no HashMap, counter-based `rng(seed, 0, x, y, salt)`, bounded work,
`rm` only with literal absolute paths), `.claude/skills/run-tests/SKILL.md` (the gate, `&&` chaining, show tests red first,
pinned hashes re-recorded only on purpose), `docs/biomes-plan.md` (sections 1, A1, A2, 4: this slice implements them),
and `sim/src/gen.rs` (`generate_world`, `carve_chambers`, `try_pool`, `place_lava`, `place_ice`, `repair_traversal`).

**Report as you go** to `/tmp/wt-biomes/docs/research/biomes-w1-report.md`: append after each commit (what landed, the
commit hash, test results, hashes that moved). It must end with a section **"Architectural decisions for review"**
(each choice later slices build on: what, alternatives, why, cost later; when unsure about a hard-to-reverse choice take
the more reversible one and flag it) and may list ideas for FUTURE.md.

## Files you may touch
`sim/src/gen.rs`, `sim/src/rng.rs` (new salts: use 260 and up, all unused), `sim/src/tuning.rs`, `sim/src/snapshot.rs`,
`server/db.ts` (format constant only), `sim/tests/*.rs` (new `sim/tests/biomes.rs`; pinned-hash and format asserts in
existing files), `sim/tests/fixtures/*`, `sim/examples/dump_world.rs`, `client/avatar.ts`, `tests/net/avatar.test.ts`,
and your report. Ask in the report rather than touching anything else.

## What to build

1. **dump_world tool.** `cargo run --release --example dump_world -- SEED SIZE PRESET out.ppm` (SIZE 0/1/2, PRESET
   `pvp` or `survival`) writes a binary PPM using the full 32-entry palette from `client/materials.ts` `paletteTable()`
   (copy the colours; unknown ids magenta). The lead uses it for screenshots (`magick out.ppm out.png`).
2. **Format 14.** `FORMAT_VERSION` 13 -> 14 in `sim/src/snapshot.rs` (extend the doc comment: "v14 (biomes): new
   generation; no layout change, bumped so stored worlds made by the old generator reset"), `SNAPSHOT_FORMAT_VERSION`
   in `server/db.ts`, the `assert_eq!(FORMAT_VERSION, 13)` lines, and the golden fixture (`golden-v13.bin` ->
   `golden-v14.bin`, regenerated with `HF_REGEN=1`). Grep `tests/` too for anything pinned to 13.
3. **Site picker** (plan section 1). `pub struct Site { pub kind: u8, pub cx: i32, pub cy: i32, pub rx: i32, pub ry: i32 }`
   with kind constants `BIOME_LAVA = 1`, `BIOME_ICE = 2` (leave 3 grotto, 4 mine for later slices; put the constants
   in `gen.rs`), and `pub sites: Vec<Site>` on `World`. Picked right after `carve_arena`, centred on worm-path points
   in the kind's depth band, rejection rules and the 64-try bound exactly as in the plan; counts via `scale_count`
   (lava `scale_count(w,h,3,1)`, ice `scale_count(w,h,3,1)`), radii scaled with the chambers' width percentage. Integer
   only; every draw a distinct salt or distinct (x, y) arguments.
4. **Lava lakes** (plan A1). For each lava site: carve the cavern (Rock and Dirt only, like `carve_chambers`; rx 70-110
   and ry about rx * 2 / 5 at L, scaled) before `connect_and_prune`. After `line_entrances_with_dirt` and **before
   `place_lava`**, fill its basin from the floor under the centre with `try_pool` generalised by a max-width parameter
   (existing calls keep 70, so their results do not move) at cap about 9000 cells at L (scale it) and depths about 6..=16;
   line it with Rock as `place_lava` does. Add two or three Rock ledges (12-20 wide, 3 rows thick) jutting from the
   cavern walls 6-10 rows above the lava surface. The ordinary `place_lava` pools still run.
5. **Ice caves** (plan A2). Replace `place_ice`'s scattered chambers with ice sites: carve a cavern (rx about 45-65,
   ry rx / 2) before `connect_and_prune`; after the liquids, line it (Rock/Dirt cells within the ellipse grown by 4 that
   touch Empty become Ice), fill its basin with Water via `try_pool` (depths 4..=8) and turn the top two rows of that
   pool into Ice; hang 3-6 icicles (1-2 wide, 3-8 long) from the ceiling. **All generated Ice gets `aux = 1`** (spent:
   static, never freezes water, not volatile). Keep water pools above `DEEP_TOP` as `try_pool` already enforces.
6. **Ice sliding** (client only, `client/avatar.ts`). When `onGround` and any cell under the hitbox's feet row is Ice
   (id 18), the horizontal blend factor is about 0.04 instead of 0.4, and the `|vx| < 0.02` snap-to-zero still applies.
   **Do not raise any speed**: the target is still `WALK`, so `MAX_SPEED_FIXED` and the server's `maxPosJump` are
   unchanged. Add a test in `tests/net/avatar.test.ts`: on an ice floor the avatar keeps sliding (more than about 8
   cells) after the key is released, on rock it stops within a cell or two; show it red first (with the ice branch
   disabled) and say so in the report.

## Tests (new `sim/tests/biomes.rs` unless a private fn forces `gen.rs`'s test module)
Over seeds 1..=8, sizes 0..=2, presets caves_pvp and survival:
- every L and M world has at least one lava site and one ice site; report the counts at S (assert at least one of each
  across the 8 seeds, and state the per-seed count you saw);
- no two sites (grown by 40) overlap; none overlaps the arena (`world.arena`, grown by `ARENA_KEEP_OUT`); none in the
  spawn clearance;
- each lava site holds at least a stated minimum of Lava cells (pick from measurement, e.g. 1500 at L) and total Lava
  in the world has an upper bound; every Lava and Water cell rests on a non-Empty cell (as the existing liquids test);
- every Ice cell the generator made has `aux == 1`;
- the existing `traversable_to_every_band`, `every_open_cell_is_reachable_from_the_sky` and `boss_gen.rs` tests stay
  green **unchanged**. If one fails, fix generation, not the test, and say so.
Show each new test red first (break the thing it guards, restore from a copy) and record that in the report.

## Pinned results
Generation changes move `golden` (fixture and `SCRIPTED_HASH`), `perf_equiv` (`PERF_REGEN=1`), and
`boss_gen.rs non_survival_worlds_are_byte_for_byte_unchanged` (update its comment: recorded at biomes-1). Re-record
them on purpose in the commit that changes generation, and list in the commit message and report exactly which
scenarios moved and which did not (sandbox scenarios must **not** move: if one does, stop and investigate).

## Commit checklist (one commit each, in order; message ends with `Co-Authored-By: Claude Sonnet <noreply@anthropic.com>`)
- [ ] dump_world tool
- [ ] format 14 (golden regenerated, nothing else moves)
- [ ] site picker + lava lakes + their tests + re-recorded pins
- [ ] ice caves (replacing `place_ice`) + tests + re-recorded pins
- [ ] ice sliding + avatar test
- [ ] report finished (can ride with the last commit)

**Per commit** (from the repo root, chained, logs to files, never piped to grep/tail):
`(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/b1-cargo.log 2>&1) && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/b1-clippy.log 2>&1) && pnpm typecheck > /tmp/b1-tsc.log 2>&1 && git add <files by name> && git commit -q -F /tmp/b1-msg.txt; echo "exit $?"`.
Before the **last** commit also run `pnpm test:determinism > /tmp/b1-det.log 2>&1 && pnpm test:net > /tmp/b1-net.log 2>&1`
in the chain. Check `uptime` first: if the load average is above 16, wait for it (other agents share the machine).
While iterating run single test files (`--test biomes`). Never commit red. Do not start servers; if you do, kill them
by literal PID before finishing. Every `rm` names a literal absolute path.
