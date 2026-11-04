# E3 spells: report (branch x-spells)

## Built
Materials (ids append): 22 Mud, 23 Salt, 24 Snow, 25 Thermite. All paintable, class solid, non-structural, in the client palette and hover names.
- Mud: powder that moves one tick in three; dries to Dirt beside Fire or Lava.
- Salt: powder; beside Ice melts it to Water (1 in 4, salt spent); beside Water dissolves into Water (1 in 8).
- Snow: light powder (falls on even ticks); melts to Water beside Fire or Lava; a resting flake under 3 snow cells packs to spent Ice (1 in 16).
- Thermite: powder, inert until beside Fire or Lava (aux = 40-tick burn); lit, it turns each Rock, Dirt, Glass, Ice, Coal, Wood or Sand neighbour into Lava (1 in 3 per tick), Water into Steam, then becomes Fire.

Spells (ids append, NUM_SPELLS 12 -> 15): 12 Freeze (bolt; on impact Water within r^2 49 becomes spent Ice, cap 80), 13 Quake (instant, no projectile; Rock or Dirt in a r5 disc 9 cells along the aim crumbles to Pebbles on a coin flip, at most 81 writes, goes through `Grid::set` so unsupported roofs crumble by the normal island rule), 14 Mudslide (flask, 70-cell Mud burst). Teleport skipped (Pos validation).
Wiring: PICKUP_CHARGES, START_CHARGES, COOLDOWN, SPEED, GRAVITY, BAG_SPELL_IDS (9 -> 12, bag record grows), PICKUP_TABLE (shallow: Freeze, Mudslide; deep: Quake), names, SPELLS table, BAR, ghost skipped for Quake, `isPaintable`, MATERIAL_CLASS, NUM_SPELLS in shared/sim.ts. FORMAT_VERSION 12 -> 13 (player and bag records grew). Golden file NOT yet regenerated.

## Status: UNVERIFIED
The `cargo test --release` build never completed inside my budget: the machine was at load average ~560 (three experiments compiling at once). Lib compiled clean (`cargo build --release` passed before tests). tests/bags.rs was mechanically widened for the new array sizes and compiled to the last error list. Nothing else has been run: no clippy, no typecheck, no golden regen, no determinism suite, no browser.
Tests written, not yet run: `sim/tests/e3_spells.rs` (ids_and_rules, mud slow and dries, salt melts ice and dissolves, snow melts and packs, thermite needs a light, freeze bounded, quake bounded, mudslide bounded, new spells deterministic and sleep-invisible, new materials sleep-invisible).

## To finish
1. `cargo test --release`; fix failures; `HF_REGEN=1 cargo test --release --test golden`.
2. clippy, `pnpm typecheck`, tests/net/spells-table.test.ts (may pin NUM_SPELLS or table lengths), `pnpm test:determinism`.
3. Check chunk-sleep volatility of each new update (the invariant most likely to bite): Mud and Snow set `vol_seen` while waiting for their turn; Salt and Thermite when next to a trigger.
4. Browser check, effects (Freeze and Quake particles), SHORT_NAMES in client/room.ts, 3 new hotbar slots may overflow the bar layout.

## Risks
- Determinism and sleep invisibility are untested for the new cell rules. Rolls beside a trigger keep chunks awake, but Mud on odd ticks relies on `powder_can_move` being exact.
- Thermite converting rock to Lava can run away in a rock mass (burn is bounded to 40 ticks per cell but each lava cell can ignite more thermite only if present); bounded per cell, not per tick.
- Snow packing to Ice interacts with the structural island rule (Ice is structural): a packed snow column may crumble/melt as an island.
- Bag record and player record grew: old snapshots are refused (version bump), fine while the game is not live.

## Architectural decisions for review
- Append ids 22-25 and spells 12-14 (alternative: reuse gaps; none exist). Costs: bag size grows with BAG_SPELLS (shared constant, client mirrors must follow).
- Freeze produces spent Ice (aux 1) so a lake cannot chain-freeze, matching existing Ice rules.
- Quake is instant like Wall/Dig, excluded from the projectile caps; bounded by a fixed disc.
- Thermite state in `aux` (burn counter), like Coal.
