# Fix A: liquids (report, in progress)

## Slice 1: the walls
Tests: `sim/tests/liquid_walls.rs`.
- Water and lava released from behind a wall across the x = 128 and 256 chunk edges: sleeping on and off give
  identical grids (1500 / 3000 ticks), and the water front reaches the far wall (x = 319) in both. So chunk
  sleeping is NOT the cause (invariant 8 holds here).
- Water released in a 1024-wide world with the active rectangle centred at x = 200: the front stops at x = 516
  (the chunk edge 512, plus a slide's reach), a 2-deep face at the edge. Moving the active centre to x = 600
  and running on lets it advance past 576. So a frozen front on the region's chunk edge reproduces the walls.
- Cause: the active region (576 x 320 around each active player, `Sim::refresh_active`). Per the brief I did not
  change its rules. Options and costs are under "Architectural decisions for review".
- Not checked: `liquid_move`/`slide` ordering as a third cause. The sleeping-on/off equality and the front
  reaching the wall show no ordering stall in these setups.

## Slice 2: resting state
Red evidence (before the rule, `cargo test --release --test liquid_rest`), 5 of 7 fail, the 2 safety tests
(ledge drains, wake across a chunk edge) pass:
- `lone water: still moving after 600 ticks`, `lone lava: ...`, `material 15 (oil) still moving ...`,
  `water film: still moving ...`, `lava film: still moving ...`.

### 2b: the rule (grid.rs `liquid_free`, `liquid_can_move`)
After the down and diagonal moves fail, a liquid cell slides sideways only if there is liquid directly above
it (pushed) or directly below it (it floats on a body). A cell on bare ground with nothing liquid above rests.
Lava (and acid) no longer count as always-volatile: lava keeps its chunk awake only while it can move
(`liquid_can_move`) or has a neighbour it can ignite, melt or glaze (flammable, coal, ice, sand), because its
reaction rolls are chance-based and must keep running. Acid stays volatile (its dilute and dissolve rolls).

Results (liquid_rest.rs, all 7 green; before the rule the 5 resting tests failed, see above): a lone water,
lava or oil cell, and a 40-wide 1-deep water or lava film, change nothing for 200 ticks after 600 and run 0
chunks (ran_chunks 0). A 4-deep pool on a ledge still pours off and drains to a film. Before: a lone cell
random-walked indefinitely and kept its chunk running every tick.

`lava_heap_levels_in_the_sandbox`, `water_levels_out` and `lava_settles_the_same_with_sleeping_on_and_off`
are unchanged and green. D7 (10 tests) green, including the new wake-across-chunk-edge case.

Expectations changed (deliberate, in `grid.rs` unit tests, because the old assertions encoded the wandering):
- `fire_melts_ice`: `ICE <= 1` became `<= 2`. Meltwater now clings where it forms, so fire beside it turns to
  steam and dies earlier; 2 of 4 ice cells remain (it was 1 before).
- `density_order`: sand sinking through lava now ends as Sand or Glass at the lava's old cell. The displaced
  lava rests on top instead of sliding away, and so touches the sand and may glaze it.
No tests/determinism expectations needed updating (they compare sim against itself, not golden hashes).
