# Fix B report: falling rock and paint

## Cause of the spikes and columns (item 1)

A bug in `Grid::crumble_islands`, not a hidden shaft and not a brush artefact. Each seed's flood stamps the cells
it visits with the pass's stamp. A later seed in the same pass that touches a stamped cell skips it as "already
handled". When the earlier flood was *anchored* (it hit the island cap or the world edge and stopped early), the
cells it had stamped but not yet expanded were never explored, and a later seed's flood standing on a thin strip
of rock next to them saw them as stamped, so it never reached the anchor and judged the strip a free island. The
strip crumbled to Sand, and Sand then falls through the empty space beneath.

Evidence (`sim/tests/paint_spikes.rs`, red before the fix):
- Survival seed 1, one `Grid::dig(20,135,26,141,5)` at the left edge (dirt over a 40-deep rock layer): before
  the fix, Rock cells became Sand at (26,170), a 4-wide column about 35 deep (the same shape as note 14).
- One 40-stroke Sand paint over dirt in the same world: a 2-cell Sand spike at (213,62..63), outside every
  stroke. With crumbling switched off (queue cleared) no Sand appears outside the brush.
- Not reproduced: the exact 100-deep, 1-2 wide column of the screenshot (a different seed and dig position).

Fix: `island_anchor`, a second stamp array. A flood that ends anchored marks every cell it visited or queued as
anchored; a later flood that reaches such a cell is anchored too. State is per pass and never hashed.

Seeds 2 and 3 of the paint probe still crumble genuinely enclosed dirt: that is the "instant fill" (item 2).

## Commits

- `bd1741d` Anchor fix in `crumble_islands` (item 1). Red first: `paint_spikes.rs` (both tests failed with the
  fix stashed, passed with it).
- `435eeb3` Hard-material paint seeds no crumbles (item 2). `paint_hard.rs`: rock ring keeps the enclosed dirt,
  sand ring still crumbles it, sleep on/off hashes match for both. The rock-ring test is red before the change
  by construction (the ring encloses dirt that previously crumbled; I did not separately stash and re-run it, so
  that red run is not evidenced).
- `3f240bf` Pebbles id 21 (item 3). `pebbles.rs`; `falling_rock.rs` expectations changed from Sand to Pebbles
  (the brief requires it; no check removed); `enemy_ai.rs` and `tests/net/avatar.test.ts` class pins extended
  to 22 ids.
- item 4 commit: Seed sprinkle, Stem/Flower unpaintable, `paint_seed.rs`, client palette.
- Gate on every commit: sim `cargo test --release`, clippy wasm, `pnpm typecheck`, `pnpm test:determinism`,
  `pnpm test:net`, all exit 0 (the Pebbles run first failed one avatar pin, fixed before the commit).

## Seed sprinkle density

1 cell in 16 (`PAINT_SEED_ONE_IN`). Expected 3 seeds at r=4 (49 cells) and 50 at r=16 (797 cells); measured
7 and 48 for one stroke at (200,200), tick 0, seed 1.

## Could not verify

- The exact 100-deep screenshot column (different seed and dig site); reproduced a 35-deep one by the same
  mechanism. Not checked in a browser, and the real avatar controller was not exercised with Pebbles.
- Seed paint on a dragged stroke over several ticks was not measured (the draw is per cell and tick).
- Instant fill (note 5) is now only by Soft strokes, by design.

## Architectural decisions for review

1. **Paint skips seeding via `Grid::set_unseeded`** (a `set` that writes and touches but records no seed),
   called from `Sim::disc` when `is_structural(mat)`. Alternatives: a flag argument on `set`; clearing
   `island_removed` after the paint input. Chosen because it is local and keeps `set` hot path unchanged.
   Cost later: a hard stroke over a *different* structural cell (Rock over Dirt) removes nothing, fine; but a
   hard stroke over Sand-free soft cells never needs seeds either. A new structural material must be added to
   `is_structural` to get this behaviour.
2. **Pebbles**: id 21, powder via `powder_move` with its own salt `SALT_PEBBLES_DIAG` (255); `powder_ok`
   unchanged (displaces Empty, light gas, Water, Lava, like Sand); class solid; not flammable, no lava glazing
   (lava displaces it as it does Sand; sand-only glazing and the "lava keeps awake near sand" check untouched);
   `dissolvable` (acid) and `dig` include it; the spawn ground check includes it. Alternative: reuse Sand with
   an aux flag. Cost: the material table is now 22 ids; the hash and snapshot are unchanged (material is u8).
3. **Sprinkle rng inputs**: `rng(world_seed, tick, x, y, SALT_PAINT_SEED=256)` per cell, 1 in 16. Alternative:
   per stamp index, which would make overlapping stamps sprinkle denser while dragging. Cost: a stroke repeated
   on the same tick over the same cells would place identical seeds.
4. **`island_anchor` second stamp array** (item 1 fix): extra `4*w*h` bytes per grid, unhashed.

## FUTURE.md ideas (suggested)

- A native "world sweep" test that digs at a grid of sites in several Survival seeds and asserts no Rock
  becomes powder (the probe took 4 s).
- A rough-grey grain variation for Pebbles in the shader.
