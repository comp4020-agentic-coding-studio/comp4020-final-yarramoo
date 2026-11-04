# Brief E report: heal drops from killed enemies

## Commits
- `f5cc4da` Commit 1: `sim/tests/heals.rs`, 12 tests, gated off with `#![cfg(any())]`. Red evidence: with the gate removed the file
  failed to compile with 52 errors (no `Heal`, `EV_HEAL`, `ENT_HEAL`, `HEAL_*`, `SALT_HEAL_DROP`, `heals` field, `drop_heal`).
- `ee02b32` Commit 2: the `Heal` entity, drop in `reap_enemies`, `update_heals` after `update_bags`, `EV_HEAL`=16, `ENT_HEAL`=8,
  hash and snapshot (FORMAT_VERSION 11), `server/db.ts` mirror, `shared/sim.ts` constants. All 12 heal tests green.
  Gate: cargo test, clippy, typecheck, test:determinism (53 passed), test:net (see below), all chained with `&&`.
- Commit 3: client drawing (`pushHeal` in `client/fx.ts`), "heal" synth in `client/sfx.ts`, `EV_HEAL` handling and "+N health" toast in `client/worker.ts`.

## Existing tests changed (layout only, no assertion weakened)
Entity bytes gained a heal count (u32) between the enemies and the round tail, so offset arithmetic moved in `sim/tests/enemies.rs`,
`spells.rs`, `bags.rs`, `tests/net/entity-layout.test.ts` (it now also asserts the heal count is 0). `write_view`/`encode`/`decode` call
sites gained the new argument. Format pins 10 to 11 in `bags.rs`, `config_state.rs` (refused list now 10 and 12), `server/db.ts`.
No recorded determinism scripts changed expectations (suite green, none kills enemies).

## Balance note (report only)
Seed 1, size M (1024x768): 18 enemies = 8 slimes, 3 acid slimes, 3 worms, 3 imps, 1 boss, so 17 normal. Expected drops
17/3 = about 5.7 heals = about 142 hp over a full descent (a solo player's 100 hp bar), plus one boss drop at the end (round already won).
Cap 16 and 60 s life are not binding. Damage sources: contact 8 to 20 per 40 ticks, boss contact 20, plus bolts, bombs, lava rings. A
boss fight alone can cost well over 100 hp, so the pool is meaningful but not generous; the boss heal is for show. Drops only appear
where kills happen, and 60 s expiry means a heal left behind is lost. Values to tune: `HEAL_DROP_ONE_IN`, `HEAL_AMOUNT`, `HEAL_LIFETIME` in `sim/src/tuning.rs`.

## Not verified
- No two-browser visual check (no browser run); the cross draws and toast are only typechecked.
- The 1 in 3 rate is checked statistically on the rng function (800..1200 of 3000), not through live enemy kills.

## Architectural decisions for review
1. **`Heal` shape**: `{x: u16, y: u16, amount: u8, expires_at: u32}`, 9 bytes, `Vec<Heal>` on `Sim` in spawn order. Alternative: reuse
   `Bag` with a flag (rejected: different payload, bag decode refuses all-zero charges) or a typed `Pickup`. Cost later: another list to
   thread through `encode`/`decode`/`write_view` (a 7-arg encode now; a struct of entity lists would be tidier next time).
2. **Drop rule**: in `reap_enemies`, `rng(seed, tick, cell_x, cell_y, SALT_HEAL_DROP=257) % 3 == 0`, cell = the enemy's feet cell; the heal appears one cell above the feet; boss always;
   only when `cfg.has_enemies()`. Alternative: roll on killer or at spawn. Cost: two enemies dying in the same cell on the same tick roll the same draw (same result, still deterministic).
3. **Pickup rule**: lowest-id living player whose hitbox covers it AND below full health takes it; gain capped, and `EV_HEAL.a` reports the hp actually gained (0 is never emitted). Alternative: anyone takes and wastes it. Cost: a full-health player standing on it blocks nothing, but heals can accumulate to the cap of 16 and evict the oldest.
4. **Snapshot/hash layout**: heal section (u32 count, then heals) sits between enemies and the round tail inside the entity bytes, so it is in both the snapshot and state hash with no separate hash code. Decode refuses count above `MAX_HEALS`, out-of-world cells, amount 0 or above 100, and heals in rooms without enemies. FORMAT_VERSION 11. The server reads the player section only (fixed offset), so it is unaffected.
5. **Event**: `EV_HEAL` carries (taker, gained, cell x, cell y); view `ENT_HEAL` carries amount in `a`. Both read-only.

## FUTURE.md ideas (suggested only)
- Heal drops scaled by enemy kind (worms and imps more likely than slimes), or a guaranteed heal at depth checkpoints.
- A visible hp-restored floating number at the heal's position for teammates.
- Let a full-health player "bank" nothing but ping teammates that a heal is waiting (minimap marker).
