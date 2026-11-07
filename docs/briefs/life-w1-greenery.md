# Brief life-W1: surface greenery at generation (canopies, shrubs, wildflowers)

**Model:** Sonnet. **Dollar cap: $7.** Read your spend at the start and after every commit:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
If you are $6 over your starting figure, stop, commit only what is green, and finish the report. **Tool-call cap: 90.**
**Do not dispatch subagents.** Work only in `/tmp/wt-life` (branch `world-life`). Never touch the main checkout
(`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`), its :8080 server, `multa` or `main`. **Do not push.**
Every `rm` names a literal absolute path (no variables, no globs on variables, no relative paths).

Read first: `CLAUDE.md` (sim invariants), `.claude/skills/run-tests/SKILL.md`, and in `sim/src/gen.rs`:
`generate_world`, `place_trees`, `surface_heights`, `Scale`, `scale_count`; `Sim::spawn_point` in `sim/src/sim.rs`;
`update_stem` in `sim/src/grid.rs` (a `STEM` with `aux == 0` returns immediately: a static, flammable green cell;
`FLOWER` has no rule at all).

**Report as you go** to `/tmp/wt-life/docs/research/life-w1-report.md`: append after each commit (what landed, the
test shown red and how, the commit hash, your spend). It ends with **"Architectural decisions for review"** (each
choice later work builds on: what, alternatives, why, cost later; when unsure take the more reversible option and
flag it) and may list ideas for FUTURE.md (the lead decides).

## Files you may touch
`sim/src/gen.rs`, `sim/src/rng.rs` (new salts: **278 and up**; grep `pub const SALT_` to confirm they are unused),
`sim/src/tuning.rs`, `sim/src/snapshot.rs` (format bump only), `server/db.ts` (the mirror only), `sim/tests/*.rs`,
`sim/tests/fixtures/*`, `tests/net/spells-table.test.ts` only if it pins the version number, and your report.
Nothing else in `client/`, `server/` or `shared/`.

## What to build (all in generation; no new material, no new cell rule)

The surface is a bare Dirt strip with leafless Wood trees. Make it green, with existing cells only:
`STEM` with `aux = 0` (green leaf, static, flammable) and `FLOWER` with `aux = 0` (pink, static, flammable).

1. **Canopies.** In `place_trees`, after each tree's trunk and branches are drawn, add a leafy canopy: an irregular
   blob of `STEM` aux 0 around the top of the trunk (radius 5-8 cells horizontally, a bit flatter vertically) and a
   smaller blob (radius 2-4) at each branch tip. Use a counter-based rng per cell (`rng(seed, 0, x, y, SALT_...)`) to
   make the edge ragged (e.g. drop a cell when it is near the edge and the roll says so). Write **only into Empty
   cells**. Optionally speckle 1 in ~25 canopy cells as `FLOWER` (blossom). Keep every canopy cell at row >= 2.
2. **Shrubs.** `scale_count(w, h, 40, 6)` small bushes (2-4 tall, 3-7 wide, a rounded mound) of `STEM` aux 0 sitting
   on the surface Dirt, with 0-3 `FLOWER` cells on top. Only on flat ground (surface height differs by at most 1
   across the shrub's width), only where the Dirt below is solid (skip entrance shafts the way `place_trees` does),
   not within 6 cells of a tree trunk, and **out of the spawn columns**: `|x - w/2| > SPAWN_JITTER + 7*16 + 8`
   (see `spawn_point`; the spawn scans 16 columns 7 apart from `w/2 + jitter`). Bounded tries (e.g. 8x the count).
3. **Wildflowers and grass tufts.** `scale_count(w, h, 260, 30)` single tufts on the surface: a 1-2 cell `STEM`
   aux 0 sprig, and about 1 in 3 of them a `FLOWER` on top of a 1-2 cell stem. Same placement rules as shrubs
   (flat, solid below, out of the spawn columns, only into Empty). Cluster them a little (pick patch centres, then
   scatter a few tufts per patch) so it reads as meadow patches rather than uniform noise.

Order in `generate_world`: right after `place_trees` (so `repair_traversal` and the spot pickers run after them, as
they do for trees). Everything must be bounded (fixed tries, fixed radii) and use only integer math.

**Spawn and traversal.** Plants are not in `spawn_point`'s ground set, so a plant cell over the spawn column would
put the spawn on top of it; that is why the spawn columns stay clear. A shrub 4 tall on the surface is above the
avatar's 3-cell step-up: that is fine (the avatar can jump it, and it burns), but **no plant may cover an entrance
shaft** (keep the "solid Dirt below" rule) and the existing traversal/reachability tests must stay green unchanged.

## Format bump
This changes every Caves world, so bump `FORMAT_VERSION` 16 -> 17 (`sim/src/snapshot.rs`; extend the version-history
doc comment by one sentence: "v17 (world-life): new generation (canopies, shrubs, wildflowers); no layout change")
and its mirror `SNAPSHOT_FORMAT_VERSION` in `server/db.ts`. Rename the golden fixture to `golden-v17.bin` the way
commit 5f7ba90 did, and regenerate pins **on purpose** as each file documents:
- `HF_REGEN=1 cargo test --release --test golden -- --nocapture` (fixture + `SCRIPTED_HASH`),
- `PERF_REGEN=1 cargo test --release --test perf_equiv` (only the game-world scenarios may move; the sandbox must not:
  check the diff of `sim/tests/fixtures/perf-trace.txt` and say which scenarios moved),
- `non_survival_worlds_are_byte_for_byte_unchanged` in `sim/tests/boss_gen.rs` (update the three hashes, extend its
  history comment),
- any test that pins the version number (`grep -rn "16" sim/tests/heals.rs sim/tests/bags.rs tests/net/spells-table.test.ts`).
Never loosen any other guard. If a traversal, reachability, boss or enemy-count test fails, fix the generation.

## Tests (new file `sim/tests/greenery.rs`; seeds 1..=8, sizes 0..=2, caves_pvp and survival presets)
- every tree has a canopy: for each Wood trunk top, at least N `STEM` cells within radius 8 (choose N, state it);
- every generated `STEM` above the shallow band has `aux == 0` and every `FLOWER` has `aux == 0` (nothing grows);
- shrubs and tufts: the count of plant cells on the surface is above a floor (state the counts you saw) and no plant
  cell lies in the spawn columns above the surface;
- `spawn_point` for ids 1..=8 still lands on Dirt/Rock with a clear 5x10 box, at every size and both presets;
- a world stepped for 600 ticks with sleeping on and off (see `sim/tests/sleep.rs` for the pattern) hashes the same
  (the plants are static, so this should be trivially true: it guards a future rule change).
**Show each new test red first**: break what it guards (e.g. skip the canopy call, give a shrub aux 1, put a tuft in
the spawn columns), see the test fail on that assertion, restore from a copy, and record it in the report.

## Commit checklist (one commit each; message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
- [ ] canopies + shrubs + wildflowers in `gen.rs` with salts, plus `sim/tests/greenery.rs` (pins not yet moved is
      not allowed: this commit includes the format bump and the re-recorded pins so it is green)
- [ ] (if needed) a follow-up tuning commit after you look at the pictures
- [ ] report finished

**Per commit** (repo root `/tmp/wt-life`, chained, logs to files, never piped; check `uptime` first and wait if load > 16):
```
(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/w1-cargo.log 2>&1) \
 && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/w1-clippy.log 2>&1) \
 && pnpm typecheck > /tmp/w1-tsc.log 2>&1 \
 && git add <files by name> && git commit -q -F /tmp/w1-msg.txt; echo "exit $?"
```
Iterate with single test files (`cargo test --release --test greenery`). The lead runs determinism and the net suite.

## Look at it
`cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo run --release --example dump_world -- 7 1 survival /tmp/w1-s7-m.ppm`
(and seed 3 at size 2), then `magick /tmp/w1-s7-m.ppm -crop 1024x260+0+0 -scale 200% /tmp/w1-s7-m.png` to see the
surface strip, and **Read the PNG**. Canopies should read as green tree crowns, not as floating blobs or walls. Do
not start servers or browsers (the lead does that).
