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
