# Biomes worker 3 report (brief biomes-3): NOT green, nothing committed in sim/

Applied the w2 patch and worked fixes 1-4. Out of tool cap before pins could be re-recorded, so the tree was reset and
the progress is saved as `docs/research/biomes-w3-wip.patch` (apply with `git apply`; supersedes the w2 patch).

## What the patch now does (on top of w2)
- Fix 2 done: `solid_ground` reverted (enemies.rs green).
- Grotto/mine sites keep `ARENA_KEEP_OUT + rx + HALL_ARENA_GAP(60)` from the arena; decoration is undone inside `arena.contains(.., ARENA_KEEP_OUT)` (`keep_arena_clear`).
- `LAVA_SITE_GAP` (90) now applies only between lava and grotto/mine sites (not lava-vs-ice), so old worlds keep their site picks.
- `pick_spots` tries 20000 -> 60000 (fix 3 first option; the full determinism run had not been repeated, see below).
- Fix 1, root cause found: the arena was sealed OFF (0 open cells, S/M/L seeds 4 and 7) at `connect_and_prune`, because a
  grotto/mine bowl cuts the network the arena hangs on, and `repair_traversal` then digs through the arena floor, which `reseal_floor` undoes. Site rejection by distance was not enough (tried gaps up to +60).
  Working fix in the patch: `generate_world` wraps `generate_inner(.., halls)`; if a Survival arena is sealed off or has a floor hole (`arena_ok`), the world is regenerated with no grotto/mine (the pre-halls world). `boss_gen` then passes fully except the pin.
- Test `grotto_and_mine_exist_...` adjusted: Survival M/L worlds may fall back (counted, <= 2 of 16 allowed); measured fallbacks: only L seed 1 survival at that point (the other 15 had 1/1 or 3/3 halls).

## State of the last full `cargo test --release --no-fail-fast` (before the 60000-tries edit)
Failing: `non_survival_worlds_are_byte_for_byte_unchanged` (needs re-record), golden, `a_scripted_survival_run_has_a_pinned_final_hash` (re-record), `every_world_gets_its_full_set_of_pickups` (L seed 4: 40/22; the 60000 edit is untested), the biomes test (fixed in the patch, untested). boss_gen reachability/holes pass; enemies pass.
Not done: pin re-recording (golden, perf_equiv, boss_gen hashes), gen time at L (not measured; w2 reported ~600 ms; the fallback regenerates once for a few Survival seeds, adding ~one gen), the "shown red" for the biomes test, dump_world images, clippy, typecheck, commit.

## Next steps for whoever continues
1. `git apply docs/research/biomes-w3-wip.patch`; run `--test determinism`; if L seed 4 still < 25 deep, drop mine count at L to 2.
2. Show the biomes test red (skip `place_mine`), then re-record pins, time L, look at dump_world, run the gate.

## Architectural decisions for review
1. **Regenerate without the halls when the Survival arena is cut off** instead of repairing the network. Alternative: pick halls before worms/arena (FUTURE idea from w2), or a hall-aware repair. Reversible; costs a second generation on affected seeds and a Survival world occasionally lacks grotto/mine.
2. **`HALL_ARENA_GAP` and lava-gap narrowed to lava vs hall sites.**
3. **Pickup tries 60000** (stops at `want`, so full worlds are unchanged).
