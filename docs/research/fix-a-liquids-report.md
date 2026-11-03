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
