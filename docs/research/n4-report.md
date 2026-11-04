# N4 report: falling rock v0.5 and falling logs (branch `falling-rock-v05`)

Not merged, not pushed. Design in D-189 (`docs/DECISIONS.md`).

## What was built
- `sim/src/grid.rs`: `crumble_islands` is now `find_islands` (the seed pass, flood factored into `flood`) then `fall_step`.
  A free island of at most 120 cells without Ice is registered in `Grid::falls` and moves down one cell per tick
  (`fall_one`: bottom-up swap of each cell with the cell below, keeping `mat` and `aux`). Others crumble to Pebbles.
- Logs: a cut tree is Wood (structural), so it falls as Wood under the same rule; fallen wood is conserved and still burns (tested).
- `sim/src/sim.rs`: before `crumble_islands` the sim fills `grid.fall_blockers` with live player and enemy hitboxes.
- `sim/src/hash.rs`, `snapshot.rs`: the falling list is hashed and snapshotted (format 13).
- Tests: `sim/tests/falling_islands.rs` (15 tests, including the world sweep); old fixtures in `falling_rock.rs` and `pebbles.rs`
  enlarged to over 120 cells; format-number tests updated; golden fixture and pinned hash regenerated.

## Architectural decisions for review
1. **Tracked falling, not stateless.** Chosen: a list of at most 16 seed cells in hashed, snapshotted state. Alternative: re-detect each
   tick from neighbours of moved cells. Rejected: after the first tick nothing marks an island as falling, and a resting island would be
   re-scanned forever or never restart. Cost: format bump to 13; a snapshot taken mid-fall carries up to 16 u32s (tested: restore mid-fall, every hash equal).
   The seed cell is the cell index of one island cell; it is re-flooded each tick, so it needs no cell list.
2. **Size cap 120 cells** (`FALL_ISLAND_MAX`, tuning.rs). Covers a generated tree (about 80) and a small ledge; bigger masses
   crumble as in v0. Cap on simultaneous falling islands 16: extras crumble (not hang), so a mass cut cannot cost more than
   16 x 121 flood visits and 16 x 120 cells moved per tick, on top of the unchanged 4000-visit seed pass.
3. **Liquids and gases are displaced, not destroyed.** The slab swaps with the fluid below, so the fluid rises through it.
   Alternative: stop at water. Rejected: a rock that hangs over a lake looks wrong. Solid below (including Pebbles, Sand,
   Dirt) stops it, since class solid blocks; falling islands do not displace powders.
4. **Players and enemies:** hitboxes of live players and all enemies block (the island waits, stays tracked, resumes). No crush damage.
   The check is on the cells under the bottom edge only, which is sufficient while the player is never inside the island (a
   player walking into a resting island's footprint is the existing "stuck in rock" case).
5. **Ice islands still crumble to Water** (they melt; a falling ice slab would be a new balance question). Painted rock that floats (D-175) is unchanged: Paint still records no seeds.
6. **Falling islands touch the anchored check each tick:** an island that lands against anchored rock sideways or below is
   re-flooded as anchored and becomes ordinary rock, never tracked again.
7. `island_visits` telemetry counts the seed pass only (existing test pins that bound).

## Known limits
- A falling island that crosses the active-rectangle edge freezes there with the rest of the frozen chunk and resumes when
  a player returns (like every cell); D7 test covers the crossing with sleep on and off.
- A seed from `falls` that is dug away drops out silently; an island split mid-fall by a dig falls on as the piece holding the seed
  and the other piece is found by the dig's own seeds.
- Not browser-checked (see below).
