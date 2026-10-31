# F5 worker report: enemies slice 2 (Fire imp, Acid slime, Burrower worm)

## Commits

### 1. Enemy-owned projectiles
- Owner scheme: `owner = ENEMY_OWNER (0x8000_0000) | kind << 16 | id` (`spells::enemy_owner`). `Sim::join` refuses any
  id with the high bit, so an enemy owner never equals a player id. `entities::decode` refuses an owner naming an
  unknown kind, with reserved bits 24..31 set, or more than `MAX_ENEMY_PROJECTILES` (16) enemy bolts.
- Readers of `q.owner`: cast cap and Black Hole cap compare `== player` (enemy ids have the bit, so never count);
  owner grace compares box id to owner (a player box never equals it, an enemy box is skipped for enemy bolts);
  `impact` Push and Fire bolt (player-owned paths unchanged; enemy bolt goes to `enemy_bolt_hit`); `explode_at`
  (enemy-owned: cause 40 + kind, no credit, no player-damage gate, knock event with attacker 0, skips the enemy loop);
  `EV_IMPACT`/`EV_EXPLODE` carry the raw owner in `player` (client: `chestOf` and `dropGhost` compare to my id, which
  cannot match; checked again in the client commit); the snapshot writes `owner` as u32 unchanged; Bomb fuse code
  does not read the owner.
- `enemy_fire` (test-only caller until the imp): integer normalisation via `isqrt`, refused at 16 enemy bolts.
- Tests (`sim/tests/enemy_bolts.rs`, 6): hurt + cause + no credit; never hurts or stops at enemies; caps; owner id; snapshot
  round trip and hostile owners; Creative (damage 0) harmless.
- Red first: with `enemy_owned` forced false and the enemy-box skip off, 2 of 6 failed (hurts-with-cause, never-hurts-enemy);
  the other four are guards that pass by nature (cap, id scheme, snapshot, damage 0).
- Gate: cargo test, clippy, typecheck, test:determinism green (exit 0).

### 2. Fire imp
- `enemy.rs`: `imp_ai` (flier, no gravity: velocity eases 1/tick toward a wanted one; closes beyond 60 cells, backs off inside
  40, bobs), `line_clear` (integer DDA, at most 120 steps, first solid cell stops it, run only when `(tick + id) % 15 == 0`),
  Fire bolt every 90 ticks via `enemy_fire`, aim lifted to cancel the bolt's drop. `step_enemy`'s movement and contact
  code was extracted unchanged into `integrate(step_up)` and `enemy_contact` so the imp reuses it (contact 0 for the imp).
  Water weakness: `weak` bit in `ENEMY_STATS`, 1 hp every 4 ticks in `enemy_hazard_scan`; immune Fire and Lava.
- Gen: `imp_spots` (13x13 Empty pocket, lower shallow plus deep top, off pickups, apart from others); `enemy_spots` now
  returns `(x, y, kind)`. Ids are placement order, slimes first, so slime ids are unchanged.
- Counts (`/tmp/f5-counts.txt`, seeds 1-3): S 3 imps (slimes 7/8/5), M 3 imps (slimes 8), L 8 imps (slimes 25). Totals <= 33.
- Tests (`sim/tests/enemy_imp.rs`, 11): distance band, flies over a pit, fires and hurts, 90-tick cadence, LOS blocked and
  clear, immune/water, placement, counts, seed 1 real terrain, D7, D5. F4's two slime placement tests now filter on kind
  (they asserted every enemy is a slime; not weakened).
- Red first: with `imp_ai` returning at once and water damage off, 7 of 11 failed; LOS, D7, placement, counts pass by nature
  (LOS tests the function directly; D7 compares two identical frozen runs under the stub).
