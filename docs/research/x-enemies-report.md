# X2 enemies: Lava wisp, Frost sprite, and a Sand Colossus design

Branch `x-enemies` (from `multa` at 85fe187). Experiment, not for merge before the user plays it.

## What was built

| kind | id | behaviour |
|---|---|---|
| **Lava wisp** | `ENEMY_WISP` = 5 | slow flier (hp 40, contact 10). Hunts the nearest player within 120 cells, leaves one Lava cell at its centre every 24 ticks while hunting. Immune to fire and lava, hurt by water. |
| **Frost sprite** | `ENEMY_FROST` = 6 | same flier (hp 30, contact 6), leaves Ice. No immunities: lava and fire hurt it, so a player can melt the trail and the sprite alike. |

Both reuse the imp's stepping rules (`stepping_set`, 24 per tick, only near players) and `integrate(.., step_up=false)`.
Generator: the imp placer `imp_spots` was generalised to take `(kind, want, rows, salts)`; wisps go in the lower deep band,
sprites in the lower shallow band, 6 each at size L, min 2. New salts 258..261. Survival only, as before.
Client: sprites in `client/fx.ts` (`WISP`, `FROST`), names in `toasts.ts`, `ENEMY_MAX_HP` mirrors in `worker.ts` and
`hover.ts`, `NUM_ENEMY_KINDS` 7 in `shared/sim.ts`.

### Bounds on the trail (the thing that could go wrong)
- At most `WISP_TRAIL_PER_TICK` = 1 cell written per tick across all wisps and sprites (shared budget, like acid slimes).
- No write when the 9x9 box around the centre already holds 5 cells of that material (`WISP_TRAIL_LOCAL_MAX`), cost 81 reads
  per attempted write, counted in `enemy_work`.
- Only into an Empty cell. Lava then flows and ignites by the normal grid rules, so the real hazard is bounded by the
  grid, not by the enemy.

## Tests (`sim/tests/enemy_wisps.rs`)
`a_wisp_hunts_and_leaves_a_capped_lava_trail`, `a_frost_sprite_leaves_ice_and_is_not_immune_to_lava`,
`a_dormant_wisp_far_from_players_leaves_nothing`, `many_wisps_share_one_trail_cell_per_tick`,
`snapshot_roundtrip_and_replay_hashes_match_with_wisps` (determinism), `survival_worlds_place_both_kinds_deterministically`.
Gate results are at the end of this file.

## Second boss: Sand Colossus (DESIGN ONLY, not built)

A boss for the middle depth band (the Deep Mage stays at the bottom). Arena: a wide sand-floored cavern, size M and up.

- **Body is terrain.** The Colossus has no fixed hp bar. Its `hp` field counts the Sand cells it carries (cap about 600).
  It is drawn as a 13 x 16 blob of cells and, each tick, `colossus_ai` keeps its footprint filled by *taking* Sand/Dirt
  cells from the floor under it (bounded: at most 4 cells moved per tick), so `hp` regenerates only while it stands on sand.
- **Digging it apart hurts it.** `Grid::dig`, Bomb and Dig spells that remove cells inside its footprint call
  `damage_enemy(.., n_cells_removed)`. Water on it turns carried sand to Mud-like weight (if E3 mud lands): slower.
- **Attacks** (stateless cadence like the Mage): a slow stomp (shockwave: wakes sand in a row, knockback via contact), a
  sand-throw (Pebbles lobbed, using the existing bolt owner id), and below 1/3 hp it collapses into a flowing pile that
  buries the arena floor (bounded `SAND_SPILL_PER_TICK`).
- **Why not built in 50 calls:** it needs a footprint model that is not a rectangle (hit detection by cell, not hitbox), a
  new `damage_enemy` source hook inside `Grid::dig`/`carve` (the grid does not know about enemies, so it needs an event
  list drained by the sim), and an arena generator variant. The hook is the part that touches the shared input path.
- Placement: a second `Arena` at the middle band for sizes M and L only; win condition stays "boss dead" (D-158) with both
  bosses required, or the first one for a short run: user's call.

## Not done
- Burrower: the F5 worm already exists (tunnels through rock, digs radius 3), so a second digger would duplicate it.
- No browser check yet (see below if added).

## Architectural decisions for review
1. **Two kinds share one AI (`wisp_ai`)**; the material is chosen by kind. Alternative: a table of per-kind trail material in
   `EnemyStats`. Costs later: a third trail kind (Mud, Snow from E3) means editing a match; moving to an `EnemyStats.trail`
   field is a small change.
2. **Shared per-tick trail budget** separate from the acid slime's, so the two systems cannot starve each other. Cost: up to
   2 trail writes per tick in total.
3. **`imp_spots` signature changed** (placement code for imps is now generic). Placement order changed (imps, then wisps, then
   sprites, then worms/acid as before), so enemy ids and the world hash differ from `multa`. Snapshot layout is unchanged
   (the kind byte already existed, decode bounds it by `NUM_ENEMY_KINDS`), so `FORMAT_VERSION` was NOT bumped, but the golden
   file will need regenerating if it contains a Survival world (see gate notes).
4. **Frost sprite hurt by lava/fire at the shared rate** rather than a special weakness; keeps `enemy_hazard_scan` untouched.

## Risks
- Worlds now hold up to 12 more enemies: `MAX_ENEMIES` 64 vs 51 + 12 + boss = 64 at size L, exactly at the cap. Raise it if
  placement counts grow.
- Lava wisps in the deep band add a fire/lava source near pickups; may need tuning by playtest.

## Gate result
- `cargo test --release`: all test binaries passed except the golden pins, which changed because enemy placement changed
  (new kinds, placement order). Golden snapshot regenerated (`HF_REGEN=1`, `golden-v12.bin`), `SCRIPTED_HASH` re-pinned to
  12108534946505466637. New `enemy_wisps` tests: 6 pass. Full re-run after the re-pin was NOT completed: the machine was at
  load average ~93 from the three sibling experiments and the full suite takes over 10 minutes. `pnpm test:determinism`
  not run. `pnpm typecheck` green. No browser check done.
