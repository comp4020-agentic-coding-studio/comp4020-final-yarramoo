# Brief quality-W1: every pickup can be walked into (Sonnet, cap $9)

Worker brief from the Track A (quality) lead, 8 Nov. Read `CLAUDE.md` and `.claude/skills/run-tests/SKILL.md` first;
they bind you. Work only in `/tmp/wt-quality` (branch `quality`). **Never push, merge, or touch any other worktree.
You do not dispatch agents.** Every `rm` names a literal absolute path.

## The bug (found and measured by the lead; do not re-investigate)
The user: "there is still the occasional issue where spells cannot be picked up". A probe over 28 worlds
(`/tmp/quality-probe/pickup-reach.txt`, method: is there any feet position where the 5x10 avatar body is free of
solids AND the sim's pickup test `hitbox_cells()` + `PICKUP_REACH_BELOW` covers the pickup cell) found 79 of 756
pickups unreachable:

1. **Q1, every Survival world: the boss supply pile.** `carve_arena` (`sim/src/gen.rs` ~line 462) carves the supply
   alcove `SUPPLY_ALCOVE_H = 8` rows tall (`sim/src/tuning.rs:346`), but the avatar is `HITBOX_H = 10` rows. No body fits,
   so all 6 pile pickups (4 Fire, 2 Bomb) are unreachable on foot. `clear_arena` (~line 498) uses the same height.
2. **Q2, about 0.4% of cave pickups:** `pick_spots` (~line 1963) requires only 8 Empty cells straight up from the floor
   cell (9 rows counting it), one column wide. The body needs 10 rows by 5 columns. Seen: Survival S seed 1 pickup 7
   (Ice at row 9 above), Survival M seed 2 pickup 10, Caves PvP L seed 3 pickup 21.

## What to do
- **Q1:** raise `SUPPLY_ALCOVE_H` so the body fits with a margin (12 is the suggestion: `HITBOX_H + 2`). Check
  `carve_arena`, `clear_arena` and any other user of the constant (grep the constant, not just the function).
- **Q2:** make `pick_spots`'s headroom check match the body: every cell of the 5-wide (`x-2..=x+2`) by `HITBOX_H`-tall box
  above the floor cell must be Empty (use the tuning constants, not literals). A rejected spot just tries the next `k`,
  as the existing checks do.
- **A regression test, shown red first** (`sim/tests/pickup_reach.rs`, new file): for Survival sizes 0, 1, 2 (seeds
  1..=6 each) and Caves PvP size 2 (seeds 1..=4), for every pickup, assert there exists a feet position (x, y in 1/16
  cell, scanning the cells around the pickup) where the player's 5x10 hitbox (use `Player::hitbox_cells` semantics,
  or the same arithmetic) overlaps no solid cell (solid = not Empty, not `is_gas`, not `is_liquid` from
  `sim/src/materials.rs`; that is the avatar's rule in `client/avatar.ts` `isSolid`) and the pickup cell lies in
  `x0..=x1, y0..=y1 + PICKUP_REACH_BELOW`. Name failures by size, seed, pickup id. **Show it red on the unfixed code**
  (save the failing output to `/tmp/quality-w1-red.log`), then green after.
- **Pinned hashes will move** (generation changed): Survival worlds for Q1; and any world where Q2 rejects a spot.
  Re-record `sim/tests/golden.rs` (`HF_REGEN=1`), `perf_equiv.rs` (`PERF_REGEN=1`) and `boss_gen.rs`
  `non_survival_worlds_are_byte_for_byte_unchanged` only if they fail, and **list in your report which scenarios moved
  and why**. If a non-Survival world moves, that must be Q2 (a spot rejected); say which seed. Bump the snapshot
  `FORMAT_VERSION` (and the golden fixture name) only if the run-tests skill or existing convention requires it for a
  generation change (v14 and v17 were bumped "so stored worlds made by the old generator reset"): follow that
  convention and say so. The game is not live, so a reset is fine.
- Any other test that pins pickup counts or positions (grep `pickups`, `PICKUP`, `supply`, `D-086`) must still pass;
  if one fails, explain why before changing its expectation.

## Files you may touch
`sim/src/gen.rs`, `sim/src/tuning.rs`, `sim/src/snapshot.rs` (version only), `sim/tests/pickup_reach.rs` (new),
`sim/tests/golden.rs`, `sim/tests/perf_equiv.rs`, `sim/tests/boss_gen.rs` (pinned values only),
`sim/tests/fixtures/` (golden fixture regen only), `tests/` fixtures only if a pinned version string requires it,
`server/db.ts` (`SNAPSHOT_FORMAT_VERSION` only, it mirrors `FORMAT_VERSION`, pinned by `tests/net/spells-table.test.ts`), and your report. Nothing else in `client/`, `server/`, `shared/`.

## Verify (machine rules: check `pgrep -fl "cargo test|vitest|test:determinism|tests/soak"` and `docker ps` first, wait for quiet)
- Iterate with single files: `cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release --test pickup_reach`.
- Then **the full gate from the run-tests skill**, in the background, each step to its own log under
  `/tmp/quality-w1-*.log`, chained with `&&`, the commit last. Never `;` before the commit, never pipe a test.

## Commit checklist (each its own commit, message ends `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
1. [ ] The red test alone? No: a red test cannot be committed (the gate is red). Commit the test **with** the fix.
   Commit 1: `sim/tests/pickup_reach.rs` + the Q1/Q2 fix + any re-recorded pins, after a green gate.
2. [ ] Commit 2: your report `docs/research/quality-w1-report.md` (not gated).

## Report (`docs/research/quality-w1-report.md`, written as you go, not only at the end)
What changed; the red output (first lines) and the green result; gate step results with log paths; which pinned
scenarios moved and why; the probe's 3 cave cases checked by name; your spend if you can tell; ideas for FUTURE.md
(listed, not added); and **"Architectural decisions for review"**: each choice later work builds on (the alcove
height, the headroom shape, the version bump or not), alternatives, why, cost later. When unsure on a hard-to-reverse
choice, take the more reversible option and flag it.

Stop at the cap; if you cannot finish, commit nothing red, write what you have to the report, and say where you stopped.
