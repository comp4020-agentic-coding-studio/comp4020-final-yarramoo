# Brief W report: frozen chunks wake when something reaches them

## Commits
1. `8edde3c` tests, red. `liquid_walls.rs` flipped DELIBERATELY: the old test asserted a water front freezes on the
   active region's chunk edge (front in 500..=520); it is replaced by `water_front_crosses_the_active_region_edge_and_settles`
   (front must pass x = 576, nothing hangs over air). Old intent (an unreached frozen chunk does not change) lives in
   `tests/wake.rs::a_frozen_chunk_nothing_reaches_stays_frozen`. Red evidence: the new liquid test failed with
   "front stopped at the active region edge: 514"; the fire and seed tests failed (0 of 100 burnt, 0 plant cells).
   The three red tests were `#[ignore]`d in that commit.
2. `c265ec2` `woken` state, rule, hash, snapshot 10, db mirror. See below.
3. `wake_load` example and `docs/research/wake-load-results.md`.

## Commit 2 changes
- `Grid.woken: Vec<bool>`; `wake(c)` (called from `touch`) sets it for frozen chunks; `step_cells` runs a chunk if
  active-and-awake or woken; `update_woken` at the end of the cell pass.
- Hash: packed bitset appended in `state_hash` ONLY when some bit is set, so worlds with none (sandbox) hash as before.
- Snapshot `FORMAT_VERSION` 10: bitset appended after the chunk records (ceil(chunks/8) bytes, padding must be 0);
  `server/db.ts` mirror 10.
- Tests that pinned 9 were updated to 10 (`bags.rs`, `config_state.rs`): pins, not weakened.
- `falling_rock.rs::generated_worlds_are_stable_across_seeds_and_sizes` now removes generated acid, lava and
  gunpowder before running: those now wake and really eat or blow up rock outside the player's region (acid ate
  rock into Pebbles in seed 1 size 1; a lava/fire interaction in seed 7 size 0), so the "terrain never crumbles on its
  own" claim only holds for the inert terrain. This is a real behaviour change from the user's decision, flagged here.
- Other tests added: fire carries on across the edge (oil strip; thin wood fuel burns out by itself, unrelated to
  waking), a seed reached by water grows, return to frozen (sand), snapshot while woken (D5-style), woken in hash,
  sleep on/off agree with a flow crossing the edge.

## Findings
- Free water surfaces never stop churning, so woken chunks holding water do not re-freeze (also true in active
  chunks; there it is invisible). Woken counts therefore only drain for powders. Numbers in the results file.
- With nobody active, `step_cells` clears `woken` (the world is frozen outright; keeps `a_frozen_world_stays_frozen`).

## Load numbers (native p95 ms, scenarios 1-5)
0.23 / 1.11 / 0.27 / 0.29 / 1.68; worst max 9.14 ms (scenario 5), peak chunks run 106. No cap added. Browser
estimate (2x, not measured in wasm) and recommendation in `wake-load-results.md`.

## Could not verify
- Wasm timing of any scenario (estimated from g2-results ratio only).
- D2 four-engine pin with an edge-crossing script: not added; the D2 script is Paint-driven in the sandbox where every
  chunk is active, so it cannot exercise the rule. The determinism suite passes unchanged. Native snapshot/sleep tests
  cover the rule.
- No two-tab browser check done.

## Architectural decisions for review
1. Where `woken` lives: separate `Vec<bool>` on `Grid` (not reusing `awake`). Alternative: a bit inside `awake`
   made semantic. Chosen so `awake` stays pure scratch (invariant 8). Cost: one more vector to keep in step with the
   snapshot and hash.
2. How it is hashed: packed bitset appended to the state-hash buffer only when any bit is set. Alternative: a
   per-chunk byte in `chunk_hashes`. Chosen so every existing hash (sandbox, reference scripts) is unchanged and no
   chunk-hash invalidation is needed. Cost: a hash computed while nothing is woken cannot be told from before.
3. Snapshot layout: bitset after the chunk records, format 10, one accepted version. Alternative: flag per chunk
   record (only works for non-pristine chunks). Cost: any format change after this needs the same bump.
4. Leaving the active set: `woken` for an ACTIVE chunk records "busy" (awake after its run), so a chunk the player
   walks away from while something moves in it becomes woken and the flow finishes. Implemented as asked. Cost: a
   chunk set woken this way is state while still active, so `woken` for active chunks is semantic too (it is cleared
   when all chunks are active or nobody is). Also set bit patterns differ between sleep on and off? No: with sleep
   off `awake` is still cleared and re-set by the same rule, so identical (tested).
5. Interaction with `sleep_enabled`: woken frozen chunks run regardless of the switch; `awake` is now cleared on
   every run even with sleeping off. Active chunks still run every tick with it off. Cost: a quiet woken chunk runs
   one more tick than strictly needed (it is only re-frozen after a quiet run).
6. No cap (per the user's decision): work per tick bounded by grid size (each chunk at most once).

## FUTURE.md ideas (suggested)
- Let a woken chunk freeze when its only activity is liquid surface shimmer (needs a hash-visible rule).
- A debug-overlay colour for woken chunks.
