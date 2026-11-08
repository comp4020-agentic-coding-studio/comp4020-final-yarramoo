# F1 worker report: Dig and roomy caves

## Commits (none pushed)
- `ff099cb` environmental death causes moved to 32..34 (sim `tuning.rs`, `shared/sim.ts`, `shared/achievements.ts` SHOVE_CAUSES, toasts comment, `claims.test.ts` now also checks ids 6-8 do not grant shoved_to_doom). Readers checked: toasts, achievements, `server/achievements.ts` (uses SHOVE_CAUSES), claim path (passes the byte through). No behaviour change.
- `3f107a4` Dig is spell 6: `NUM_SPELLS` 7, all arrays, `Grid::dig` is a capsule (`dig(ax, ay, bx, by, r)`, integer-only, radius clamped to `DIG_RADIUS` 7, each segment component to `DIG_REACH` 14), `dig_cast` in `spells.rs`, Blast no longer digs, snapshot FORMAT_VERSION 5. Tests: bounded-work (shown red with both clamps removed), capsule extents, Dig down / not water / Blast no longer digs / unlimited + cooldown, bags, snapshot and config_state version tests updated.
- `10bd5dc` client: names, spell table (colour 0.7,0.5,0.3), `BAR = [0,1,6,2,3,4,5]` (Dig is key 3), `fx.dust`, "dig" sfx (lowpass noise + band grit + square thump), capsule preview (rotated rounded rectangle, `DIG_RADIUS`/`DIG_REACH` pinned in `spells-table.test.ts`), ghost treats Dig like Blast (small marker, speed 0). Also fixed a server finding: `activePlayersIn` in `server/world.ts` hard-coded a 65-byte player record; now `21 + 6*NUM_SPELLS + 8` (71). `tests/net/entity-layout.test.ts` PLAYER size updated to 71 (it caught this).
- `0150744` worm radii r 10-16 start 12 at L, scaled by width (100% L, 80% M, 60% S, min 5); `borders_surface_and_open_fraction` off-band column limit 60 -> 120 (entrance shafts are about twice as wide); gen measurement test (`--ignored`); M5 determinism script gets 3 more self-bomb ticks (630/695/760) because the wider caves removed the one self-death.
- `6639d78` chambers: `carve_chambers` after `carve_worms`, before `connect_and_prune`; salt `SALT_GEN_CHAMBER`; test `chambers_open_roomy_caverns_on_the_path` shown red with an early return.
- A final commit adds screenshots and this report.

## Numbers
- Dig casts to dig 100 rows straight down: 7 (cooldown 18 ticks; Blast needed far more at 6 cells a cast).
- Gen time native release, best of 4 seeds, before / after (worms+chambers): S 29 -> 25-33 ms, M 79 -> 88 ms, L 241 -> 290-374 ms (noisy; the machine was loaded during some runs).
- Open fraction avg: S 38 -> 40%, M 35 -> 37%, L 29 -> 33%.
- Pickups per seed, shallow/deep: S 7/6, M 10/6, L 40/25, identical before and after (they are counted from target spots, which the roomier terrain still satisfied).

## Verification
Gates passed on commits 1-5: cargo test --release, clippy wasm, typecheck, `pnpm test:determinism` (41 tests). `pnpm test:net` 308 passed at the client commit and at the end of the chambers work (run before the m5-state expectation was restored to its original value, which does not touch net).
Screenshots: `docs/art/shots/f1-caves-{before,after}-seed{1,8}.png` (L size), `f1-dig.png`.

## Not verified
- `f1-dig.png` shows the Dig slot selected with infinite charges in the local game, but the preview capsule and a visible dig after clicking were not confirmed: the avatar view is tiny and I ran out of tool budget. Please check by hand with `pnpm dev:client`, press 3, aim and click.
- Boot with an old format-4 snapshot: from reading `server/world.ts` `loadFromDb`, a wrong-format snapshot fails `verifier.check` with kind other than "unavailable", so the world resets (logged `world.build_changed outcome=reset`); it does not stop the server. Not run. Note `SNAPSHOT_FORMAT_VERSION = 3` in `server/db.ts` is a stale label I did not touch.
- No second-browser multiplayer check of Dig.

## Architectural decisions for review
1. Environmental cause range 32..34 (u8 on the wire, the claim byte). Alternative: renumber to NUM_SPELLS+n (breaks again at the next spell). Cost: none; 32 spells of headroom.
2. Dig appended as id 6, bar slot via `BAR` map. Alternative: insert at id 2 (renumbers stats keys, bags, saved claims). Cost: the sim's `p.charges[2 + k]` bag loop assumes the bagged spells are ids 2..=5; Dig at 6 is outside it, which is intentional but implicit (`BAG_SPELLS` stays 4).
3. Capsule via integer point-to-segment distance without division (`|p*L2 - d*t|^2 <= r^2 L2^2`), i64. Alternative: stamp discs along the segment (simpler, uneven edge). Cost: the end caps are exact semicircles; future spells can reuse `Grid::dig` signature, which changed (callers elsewhere must pass both endpoints).
4. Chambers are ellipses (ry = 2/3 rx) centred on randomly chosen worm-path points in a band, carved after worms and before pruning, so they are joined by construction. Alternative: separate pass picking random centres and linking them with `wander_link`. Cost: chamber count depends on how many path points fall in the band (skipped silently if none), and the chambers can clip into a pool-free floor-less void; pickup spots are chosen after, so they land on chamber floors.
5. Worm and chamber sizes scale with world width (60-100%), not height. Cost: M (1024) is 80%.
6. Server parser `PLAYER_RECORD` now derives from `NUM_SPELLS`, but the other constants (21, 8) are still hand-copied and pinned only by `entity-layout.test.ts`.

## Ideas for FUTURE.md (suggested)
- Derive the server's snapshot offsets from a sim-exported layout table instead of hand-copied numbers.
- Dig strength tiers (a bigger capsule as a pickup).
- A test that the M5 script's coverage assertion survives gen changes without editing the script (generate the self-death reactively).
