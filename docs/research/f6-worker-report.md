# F6 worker report: the boss (Deep Mage) and the Survival win

## Commits

### 1. Arena
- `gen.rs`: `generate_world(g, seed, with_arena)` (the old `generate`/`generate_with_path` call it with false, so non-Survival
  terrain is byte for byte unchanged; pinned by FNV hashes recorded before the change). `carve_arena`, `clear_arena`,
  `supply_pile`, `Arena` (centre, radii, floor row, alcove side; derived data kept on `Sim` and `Base`, not hashed).
- Arena radii: L rx 70 / ry 40; scaled by the chamber percentage (M 80%, S 60%) with floors rx 40 / ry 24 (S 42x24 -> 40x24,
  M 56x32, L 70x40). Flat floor at `cy + ry/2`, 3 pillars, alcove 28 cells wide beside the rim with 6 supply pickups.
- Gen order: arena carved after chambers, before `connect_and_prune`; `clear_arena` (liquids, gas, sand, gunpowder inside the
  ellipse grown by 16) runs after all materials and before `repair_traversal`. Enemy and pickup placement skip the grown ellipse.
- The centre is chosen only among worm-path points already connected to the sky (first version picked a sealed pocket that
  `connect_and_prune` then filled: tests were red with "0 open cells", "arena unreachable" for size L seeds 1 and 4).
- Tests `sim/tests/boss_gen.rs` (5). Red first: the three arena tests failed on the first (sealed-pocket) version; the unchanged
  test is a recorded-hash guard that passes by nature.
