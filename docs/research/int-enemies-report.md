# INT-1: wisp and frost sprite integrated onto multa, placed by biome

Branch `int-enemies` (from multa 953a079). Commits: 8dca52a (port, kinds 5/6, salts 270+), 18b736a (biome placement + test),
ae7f807 (hover boxes), c7ba96a (re-recorded pins). Kind 7 left free for the Sand Colossus.

## What changed
- `sim/src/enemy.rs`, `tuning.rs`, `shared/sim.ts`, `client/{fx,toasts,worker,hover}.ts`: as on x-enemies (kinds 5 wisp, 6 frost,
  `NUM_ENEMY_KINDS` 7). Hover boxes for both kinds were missing on the branch and are added.
- `sim/src/rng.rs`: the branch's salts 258..261 collided with `SALT_GEN_BIOME` (260/261) on multa, so the new ones are
  `SALT_GEN_WISP_X/Y` 270/271, `SALT_GEN_FROST_X/Y` 272/273, `SALT_GEN_BIOME_ENEMY` 274 (no other salt at 269+).
- `sim/src/gen.rs`, `sim.rs`: `enemy_spots` now takes the generated `sites`. `imp_spots` takes an `ImpSpec` (kind, count, rows,
  salts, optional anchor). Wisps: pick a lava site (counter-based), a point in its bounding box, require an Empty 13x13 pocket and
  Lava within 24 cells (`ANCHOR_NEAR`). Frost sprites likewise with ice sites and Ice. Fallback when a world has no site of that
  kind: the old band rows and only the size minimum (2). Counts stay 6 each at L, 2 at the minimum size.
- `sim/tests/enemy_wisps.rs`: six ported tests plus `enemies_are_placed_by_biome` (seeds 1-12 with both biomes: every wisp within
  30 of Lava, every frost sprite within 30 of Ice, at most 12 total). Shown red on the band placement (seed 1, wisp not near Lava).
- Pins: golden bytes and `SCRIPTED_HASH` (8687946991476048525 -> 9307713064455008346) and `perf-trace.txt` re-recorded. Only the
  `survival_l` state column moved; the grid column and all other scenarios are unchanged. Every other test binary passed.
  `FORMAT_VERSION` not bumped (kinds only, record layout unchanged).

## Observed placement (seeds 1-12, size L survival, probe)
Wisps 2 on every seed, frost sprites 2 on ten, 1 on seed 4, 0 on seed 12. The counts are below the L target of 6 because the
anchor needs both a site and an Empty 13x13 pocket within 24 cells of the material, and ice caves are cramped. That is a tuning
choice for the user (raise `ANCHOR_NEAR` or relax the pocket, see below).

## Screens (vite :5197, seed 7, survival)
`docs/research/shots/int-enemies-wisp.png`: the avatar beside a Lava lake with a wisp over it. `int-enemies-frost.png`: two frost
sprites inside the ice cave ellipse, above its pool.

## Gate
See the end of this file (filled in after the run).

## Architectural decisions for review
1. **Anchor by bounding box of the site plus a nearby-material test**, not by walking the lake cells. Alternatives: scan the grid
   for Lava cells and spawn at their edges; add the spawn to the site code. Why: reuses `imp_spots`, needs no new scan of the grid,
   deterministic by counter. Cost: low counts when pockets are tight; the 13x13 Empty pocket rule is the limiter.
2. **`enemy_spots` signature takes `&[Site]`** (the only caller is `Sim::new_with_base`; base-cache restore skips it). Later cost:
   the Sand Colossus placer can take sites the same way.
3. **Fallback is the band rows at the minimum count**, so lakeless worlds still have a couple, rather than none. Reversible: pass 0.
4. **New salts 270+** instead of the branch's 258..261 (collision with biome salts). Any later salt must start at 275.
5. Spawn order is still imps, wisps, frost, worms, acid: changes enemy ids against multa's last commit, hence the re-pins.

## Ideas for FUTURE.md
- A wisp or sprite trail that reacts to biome (frost sprites freezing lake surfaces near lava for a bridge).
- Let `ANCHOR_NEAR` and the pocket size scale with site radius so ice caves hold the full 6.
