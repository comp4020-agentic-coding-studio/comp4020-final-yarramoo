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

### 2. Boss kind
- `ENEMY_BOSS` 4, `NUM_ENEMY_KINDS` 5, hp 1200, box 11x14, contact 20, immune Fire and Lava. One boss per Survival world, at the arena
  centre (8 cells above the floor), given the highest placed id.
- Stepping priority: `stepping_set` steps the boss first when in range, then lowest ids, then sorts (flag below).
- `boss_ai`: imp-style flier (eases velocity 1 per tick), closes beyond 14 cells, Fire bolt every 60 ticks via `(tick + id) % 60`, LOS reuses
  `line_clear`. Leash: a soft push toward the centre near the rim plus a hard undo of any move that ends with the centre outside the ellipse.
- State: boss phase lives in `state` bits 2..3 (1..3, hashed, snapshotted, decode-checked); `hop_until` is reused as the boss's summon counter
  (decode-checked <= 40). No format bump: the layout is unchanged.
- Tests `sim/tests/boss.rs` (6). Red first: the leash test failed on the first version ("left the arena at tick 3") and the fire test failed
  while the test player stood behind a pillar (fixed in the test setup: the player floats above the pillars). A snapshot hostile test covers phase 0/4, counter, hp, kind.
- Gate green.

### 3. Phases 2 and 3
- Phase derives from hp thirds, only rises, emits `EV_ENEMY_PHASE` (14; a = id, b = phase). Boundary: exactly 800/1200 is phase 2, 801 phase 1.
- Phase 2: Bomb lob every 120 ticks (`BOMB`, enemy-owned), summons: 2 imps per cast every 300 ticks, at most 4 alive, 40 per fight, rng cells
  (8 tries) that are Empty 5x4 pockets inside the arena. Summon id = boss id + 1 + counter (counter is the boss's `hop_until`, hashed, snapshotted,
  decode-checked), so ids are unique forever and stay sorted. Phase 3: speed x1.5, 3-bolt fan every 90 ticks (bolts that don't fit under the cap
  of 16 are dropped), 24-cell lava arc every 240 ticks via `Grid::set`.
- Enemy count: L seed 1 places 51 normal + 1 boss; plus 4 summons alive = 56 <= 64 (asserted for seeds 1-4).
- Work maximum (`/tmp/f6-boss-work.txt`): 1226 cells per tick with the boss in phase 3, 4 summons and the rest of the stepping set; test bound 1400, and the
  test also asserts work > 700 so halving the bound fails.
- Tests `sim/tests/boss_phases.rs` (6). Red first: two failed on the first run (a wrong boundary expectation of mine, and a check that summons are inside the
  arena, rewritten to track only fresh ids); both were test errors, not sim errors. Honest note: I did not run the file against a stubbed sim.
