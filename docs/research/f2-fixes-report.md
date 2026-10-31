# F2 review fixes: worker report

## 1. Avatar collision
- Red first: new test `avatar material classes` in `tests/net/avatar.test.ts` failed with `Expected "liquid", Received "solid"` (id 15 Oil) before the fix.
- Fix: `MATERIAL_CLASS` in `shared/names.ts` (index = material id) is the one list; `isGas`/`isLiquid`/`isSolid` in `client/avatar.ts` read it. Gas is a gas, Oil and Acid are liquids (wade, swim).
- Server: no solid set exists in `server/` or `shared/avatar.ts` (grep for isSolid/WATER/LAVA found only client code and unrelated achievement constants). Pos validation is speed-only.
- Sim: no collision physics. `spawn_point` takes the first DIRT/ROCK/SAND/BEDROCK as ground, so liquids are skipped; its `clear` check wants an all-Empty box, so a Gas pocket just makes it try the next column (harmless, left alone).
- Gate: cargo test, clippy, typecheck, test:determinism and test:net all green.

## 2. Acid hurts players
- `CAUSE_ACID = 35` in `sim/src/tuning.rs` and `shared/sim.ts`; `hazard_scan` charges 1 HP when `tick % 4 == 0` and acid touches the hitbox; lava wins over both, fire wins over acid. Toast "dissolved in acid" (with a killer: "X dissolved Y in acid"); 35 added to `SHOVE_CAUSES`. Snapshot and `PLAYER_BYTES` unchanged.
- Red first: `acid_costs_one_hp_every_four_ticks_and_lava_wins` (sim/tests/damage.rs) failed with 0 HP lost vs 5 expected before the `hazard_scan` change. Also covers the CAUSE_ACID death event; toast test extended in `tests/net/toasts.test.ts`.
