# Brief biomes-3: finish the grotto and the old mine (from the WIP patch)

**Model:** Sonnet. **Tool-call cap: 60.** This is a finishing job: the design and a full first implementation exist.
**Work only in `/tmp/wt-biomes`** (branch `biomes`). Do not touch the main checkout, `main` or `multa`. **Do not push.**

Read: `CLAUDE.md` (sim invariants; `rm` only with literal absolute paths), `.claude/skills/run-tests/SKILL.md`,
`docs/briefs/biomes-2.md` (section "Generation" is the spec for the grotto and mine), and
`docs/research/biomes-w2-report.md` (what the last worker found). The WIP is
`docs/research/biomes-w2-grotto-mine-wip.patch`: apply it with `git apply` and start from there.

**Report as you go** to `/tmp/wt-biomes/docs/research/biomes-w3-report.md` (append after each step; end with
"Architectural decisions for review").

## Files you may touch
`sim/src/gen.rs`, `sim/src/rng.rs`, `sim/src/tuning.rs`, `sim/examples/dump_world.rs`, `sim/tests/*.rs`,
`sim/tests/fixtures/*`, your report.

## Known failures with the patch applied, and the fixes the last worker proposed
1. `boss_gen`: arena floor holes and an unreachable arena (S seed 7, L seeds 4 and 7). Reject grotto and mine sites whose
   ellipse, grown by the hall decoration's reach plus `ARENA_KEEP_OUT`, comes near the arena (as lava and ice already
   are), and make sure decoration never writes inside `arena.contains(x, y, ARENA_KEEP_OUT)`.
2. `enemies.rs`: a slime spawned standing on Moss because the patch added MOSS|BRICK to `solid_ground`. Revert that edit
   (keep `solid_ground` as it was on the branch).
3. Determinism pickups test: L seed 4 has 22 deep pickups (< 25) because mines take deep floor. Prefer raising the
   deep-band spot tries or loosening nothing else; if that is not enough, keep the mine band shallower than the deep
   pickup band's lower half, or drop the mine count at L to 2. Say which.
4. Gen time at L was about 600 ms with the patch (490 without). Keep it under 650 ms; report the number.
Then re-record `golden` (`HF_REGEN=1 ... --test golden -- --nocapture`, paste `SCRIPTED_HASH`), `perf_equiv`
(`PERF_REGEN=1`) and the `boss_gen` non-survival hashes, and list which scenarios moved (sandbox must not).

## Tests
The patch's `grotto_and_mine_exist_and_their_materials_stay_bounded_and_clear_of_the_arena` never went red. Show it red:
break what it guards (e.g. skip `place_mine`, or let decoration write into the arena) and record the message. Every
existing traversal, reachability, `boss_gen`, enemy and determinism test stays green **unchanged**.

## Commit checklist (messages end with `Co-Authored-By: Claude Sonnet <noreply@anthropic.com>`)
- [ ] grotto + mine generation, fixes 1-3, the generation test, re-recorded pins (one commit is fine: the halls share code)
- [ ] report finished

**Commit gate** (repo root, chained, logs to files, never piped):
`(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/b3-cargo.log 2>&1) && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/b3-clippy.log 2>&1) && pnpm typecheck > /tmp/b3-tsc.log 2>&1 && git add <files by name> && git commit -q -F /tmp/b3-msg.txt; echo "exit $?"`.
The lead runs determinism and net afterwards; you need not. Check `uptime` first (wait if load > 16). Iterate with
single test files (`--test biomes`, `--test boss_gen`, `--test enemies`, `--test determinism`). Never commit red. Look at
an L world with dump_world (`cargo run --release --example dump_world -- 1 2 survival /tmp/b3-l.ppm`, `magick` to PNG,
Read it, crop to a mine and a grotto) and say in the report what they look like. Start no servers and leave no
background loops running when you finish.
