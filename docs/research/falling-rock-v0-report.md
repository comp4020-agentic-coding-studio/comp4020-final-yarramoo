# Falling rock v0: report

Commit 11b2a8d: seed queue, bounded flood, anchored rule, crumble, tests (`sim/tests/falling_rock.rs`).
Gate (cargo test --release, clippy wasm32 -D warnings, pnpm typecheck, pnpm test:determinism) all exit 0; `pnpm test:net` 314 passed.
Each new test was shown red with `crumble_islands` short-circuited (5 of 9 failed; the 4 negative or vacuous ones, such as "anchored stays" and "stable world", pass trivially without it, as expected).

## Measured
- Flood work per tick in the D2 scripts: NOT measured (budget). `island_visits` is exposed as telemetry for it.
- Generated world: seed-1 Survival, 600 ticks, player standing: zero islands crumbled, so generation needed no handling.
- Side effect: `enemy_acid::a_generated_acid_slime_on_seed_1_reaches_a_player_beside_it` carved a loose rock floor, which is a free island and crumbled. The test now seats the floor on a Bedrock row (a fixture change, no expectation weakened).

## Architectural decisions for review
- Seed hook: `Grid::set` queues the 4 structural neighbours when a structural cell becomes non-structural (cap `MAX_ISLAND_SEEDS` = 32, extras dropped). Direct `mat[..] =` writes (generation, test fixtures) never seed. Cost: any caller of `set` that removes solids is covered, including dig, carve, acid, explosions.
- Structural = Rock, Dirt, Wood, Ice, Glass, Coal. Sand and liquids are not structural, so a sand-supported rock island still counts as free.
- Anchored: fill reaches `ISLAND_MAX` (400), touches Bedrock, touches the world edge, or hits the remaining per-tick budget (`ISLAND_WORK_MAX` 4000, which clamps the limit, so a budget-starved fill is anchored rather than crumbled).
- Seeds beyond the budget are DROPPED, not carried (carrying would be hidden state). A dropped seed means an island may stay hanging until another cut near it. Queue is empty at the end of every tick (asserted in tests).
- Crumble: everything becomes Sand, Ice becomes Water, Coal and Wood become Sand (flagged: Wood and Coal lose their burn behaviour). Written directly (not via `set`) so the island does not reseed itself; `touch` wakes chunks.
- Frozen chunks: the flood reads `mat` only, never `awake` or `active`; it runs on writes that happen identically on every client. A free island in a frozen chunk is therefore crumbled too (the cells are then touched and run when the chunk wakes). D7 test passes with sleep on and off.
- Called at the end of `Sim::step` (after hazard scan, before canary), so the crumbled sand starts falling next tick.
- Not checked: traversal guarantee beyond the existing `traversable_to_every_band` (it passes); no new RNG salt was needed (crumble is deterministic).
