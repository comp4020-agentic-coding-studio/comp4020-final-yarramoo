# Review of F5 (59a7cec..101ed61): imp, acid slime, worm, enemy bolts

Read-only review of the diff. No builds or tests were run. Verdict: no blockers. Two should-fix items, several nits.

## Findings

### 1. should-fix: `enemyBoltSeen` never evicts, so crackle sounds stop after 64 entries
`client/worker.ts:161,729-730`. The set is only added to and never cleared. The key is `${q.id}:${Math.round(q.x/4096)}`, and `q.x` is in 1/16 cell, so the bucket is 256 cells wide. The result:
- One imp firing repeatedly inside one 256-cell column crackles once per session, not once per bolt.
- After 64 distinct keys, no enemy bolt makes a sound for the rest of the session.
- The set is not reset on room change; only `names`, `shown` and `poses` are cleared (`:301-307`).

Scenario: a player fights imps for a few minutes and the fire-bolt sound silently disappears.

Fix: key on a per-bolt identity. There is none, since `cast_seq` is 0, so detect a new bolt by `q.age`, or hold a per-frame set of the current enemy-bolt ids and drop keys that have gone. At minimum clear the set on `ls` reset and expire old entries.

### 2. should-fix (test quality): the acid-slime "slower" test is not a real test
`sim/tests/enemy_acid.rs:51-67`. The worker admits it passes red (`f5-worker-report.md:49-51`). It compares arrival ticks `ta > ts` from one start position with one seed, so the hop jitter can decide the outcome. A speed regression to `ACID_SLIME_HOP_VX = 5` could still pass.

Fix: assert the horizontal distance covered in a fixed window, for example 300 ticks, in a single-seed arena with a ratio bound, or assert directly on the hop vx and hop interval. Then show it red with `ACID_SLIME_HOP_VX = SLIME_HOP_VX` and `ACID_SLIME_HOP_EXTRA = 0`.

### 3. nit: `Event.player` carries the enemy owner (high bit) in `EV_IMPACT` and `EV_EXPLODE`
`spells.rs:376,417,682`. This is safe today. I checked every reader:
- Client `EV_IMPACT` and `EV_EXPLODE` use only a, b, c. They never call `chestOf` or `poses.get` on `player`.
- `EV_CAST` is never emitted by `enemy_fire`, so there is no pose or ghost use.
- No server code reads these events (grep of `server/` found none).

But `shared/sim.ts:61-63` documents `player = owner`, and any future consumer that treats `player` as a player id will hit this. Fix: add one line to the `shared/sim.ts` doc comment ("high bit set means an enemy-owned bolt, never a player"). Consider a client helper `isEnemyOwner(id)` so `worker.ts:729` does not hard-code `0x80000000`.

### 4. nit: an enemy-bolt kill can still carry a player as killer
`spells.rs:580-581`, `apply_damage`. `enemy_bolt_hit` correctly sets no `last_hit_by`. But `apply_damage` credits `last_hit_by` if it is within `KILL_CREDIT_TICKS` (300). So a player who hit or shoved the victim under 5 s earlier is the claimed killer of an imp-bolt death:
- That player gets kills +1 and First blood or Five kills.
- The toast still reads "burned by an imp" because `formatDeath` only names the killer in the player-caused branches (not verified here).

Contact damage already behaves the same way (pre-existing, `enemy.rs:361`). The brief's "enemy bolts never credit a player" holds only for the bolt's own hit. Fix, if wanted: in `apply_damage`, when `cause >= CAUSE_ENEMY_BASE`, treat the kill as uncredited (`killer = 0`), or document that last-hit credit wins.

The server cannot be broken by this. The killer id is always 0 or a real player id, and `world.ts:1113` zeroes an unseen killer.

### 5. nit: `imp_spots` does not honour its doc comment ("off the spawn column")
`gen.rs`, `imp_spots`. It never applies the `ENEMY_SPAWN_CLEAR` or `ENEMY_SPAWN_ROWS` check that `floor_spots` applies. In practice `y_lo = (shallow_top + deep_top) / 2` is far below the surface spawn, so it is fine at all three sizes, but nothing enforces it. Fix: add the check or fix the comment. The imp's 13x13 Empty pocket is otherwise a good "open air" test.

### 6. nit: `line_clear` under-counts `enemy_work` when blocked
`enemy.rs:55`. `enemy_work` is only incremented on a clear line. A blocked walk costs up to 120 steps and is not counted. The cost stays bounded: one walk per imp per 15 ticks, at most 24 imps stepped. Fix: add `k` on the early return, or add `n` before the loop.

### 7. nit: stale label and thin coverage in the work-count test
`sim/tests/enemy_ai.rs:257-270`. The test is slime-only. The output string still says "48 slimes" with `MAX_ENEMIES` now 64. The worm test pins the exact `24 * 49` (good). No test mixes 24 imps with a clear line, 24 worms and acid slimes. The sum is bounded by hand: 24 x (120 + body tests) or 24 x 49, so it is acceptable. Fix: relabel, and optionally add one mixed worst-case test.

### 8. nit: `decode` accepts enemy-owned bolts of any spell
`entities.rs:364-368`. It validates the kind bits, the reserved bits and the count of enemy bolts, but not `spell == FIRE_BOLT`. All consumers are guarded (Push, Bomb and Black Hole behave sanely, `explode_at` handles enemy owners), so there is no crash. A snapshot comes from the server's own store, so the risk is theoretical. Fix: require `spell == FIRE_BOLT` for enemy owners, which is stricter and cheap. It would also let the dead enemy branches in `explode_at` go.

### 9. nit: `ENEMY_MAX_HP = [20,30,60,90]` is unpinned
`client/worker.ts:162`. It is render-only (health bar fraction), so a mismatch cannot desync. A new kind or an hp tweak silently skews the bars (`?? 20` fallback). Fix: add a vitest that parses `tuning.rs` `ENEMY_STATS` hp values and compares, or export the hp list through the ABI or `shared/sim.ts`. The client is render-only otherwise: it only reads entities and events, and `dropGhost` and `q.id === myId` compare against real ids.

### 10. nit: worm dig primes Gunpowder it passes through
`Grid::dig` (`grid.rs:847`) sets `aux = 1` on Gunpowder. A tunnelling worm therefore arms any gunpowder deposit within 3 cells. This is deterministic, consistent with the Dig spell, and probably desired. Worth a line in `FUTURE.md` or the decisions log only.

## Checked and found fine

1. **Owner ids.** `Sim::join` refuses `id & ENEMY_OWNER != 0` (`sim.rs:281`) and is the only place players enter.
   - The wire `Join` is never accepted from clients. The game world stamps Join with `joined.playerId`, and `main.ts:1137-1172` rejects any kind other than Pos, Cast or Paint as `bad_kind_or_length`.
   - Ids are SQLite rowids from `createPlayer` (`db.ts:262`). The registration cap is 900 and 60 per minute, so reaching 2^31 is impossible in practice. The zero or unknown token is refused (`identity.ts:70`), so there are no ad-hoc ids.
   - Defence in depth: an assertion in `createPlayer` that `id < 2^31` would be cheap. `ENEMY_BOX` equals `ENEMY_OWNER` (both `0x8000_0000`), so the box-id and owner namespaces coincide on purpose, and `join` protects both.
2. **`q.owner` readers.**
   - The per-player cap (`spells.rs:90,92`) uses `owner == player`, so enemy bolts never count. Enemy bolts are capped at 16 and also count toward the 256 total, so they cannot starve players.
   - Owner grace (`:336`) compares with a box id; an enemy owner never matches a player.
   - `hit_player` and `Push`: an enemy-owned Push is skipped (`:421`).
   - `fire_bolt_hit`: not reached for enemy bolts (`:440`).
   - `explode_at`: enemy-owned means cause 40+kind, no `last_hit_by`, `c: 0` in the knock event, and no enemy damage. Unreachable from `enemy_fire` anyway (only Fire bolt), so it is a guard.
   - The Bomb fuse does not read the owner.
   - Black Hole pull: `t.id != q.owner` is true for enemy owners, as intended.
   - Stats: `EV_CAST` is not emitted for enemy fire, and server `castStat` counts only client Cast inputs, so an imp cast is never counted against a player.
3. **Death claims.** The killer is `last_hit_by` or 0, never a high-bit id. `main.ts` `onDeathResolved` and `world.ts:1113` need no change. Cause 40+kind is covered by `formatDeath` (`>=40 && <48`) and is not in `SHOVE_CAUSES` (32-35). `apply_damage` env-gates cause >= `NUM_SPELLS`, so enemy bolts do nothing when `damage_from_env` is off, the same as contact.
4. **Bounded work.**
   - Worm: 49 cells per step (the dig radius is clamped by `dig` to `DIG_RADIUS`), exactly pinned by test.
   - Acid trail: at most 1 cell per tick via the shared `trail` budget; the burst is capped at 12 cells (`burst` clamps to `OIL_BURST_CELLS` and a 13x13 scan).
   - LOS: at most 120 steps, gated by cooldown, `(tick+id) % 15` and range.
   - Imp bolts: 16, enforced in `enemy_fire` and in `decode`.
   - `MAX_ENEMIES` 64 and `MAX_ENEMIES_STEPPED` 24 are enforced at decode. The generator's L count is 51.
5. **D7.** `stepping_set` uses players only and no AI path reads `grid.awake`. Worm digs go through `Grid::set`, which wakes the chunk, so digging into a frozen chunk is the same with or without sleeping. LOS and imp collision read cells in frozen chunks. A frozen chunk's cells are by definition unchanged this tick, so the read is identical either way.
6. **Gen.**
   - Worms need a 13x13 solid Rock block (`WORM_BURIED_CELLS = 6`) in the lower deep band, away from pickups and other enemies, and `cy + r < h - 8`.
   - The tunnel only adds open space, and `dig` never removes liquids, bedrock or anything outside its list, so `traversable_to_every_band` cannot be broken. A pool next to a fresh tunnel simply flows in, which is a gameplay effect, not a connectivity break. It cannot reach the surface spawn because worms start deep and hunt within 120 cells only.
   - Imps need a 13x13 Empty pocket. Enemies exist only when `cfg.has_enemies()` (Survival).
   - The salts 244-249 are unique within `rng.rs`.
7. **Snapshot.**
   - `encode` writes the owner as a full u32, so the enemy bolts are covered.
   - `decode` rejects: a kind >= `NUM_ENEMY_KINDS`, reserved bits `0x7f00_0000`, more than 16 enemy bolts, `state > 3`, `facing > 1`, `hp` 0 or above the kind's max, and a non-monotonic id.
   - `ENEMY_BYTES` is unchanged. Enemy fields are the same as F4: `state` bit 0 is hunting or awake, bit 1 is airborne, and the worm uses bit 0 only. `size()` is `write().len()` by construction (`snapshot.rs:45`). `FORMAT_VERSION` is untouched at 8, so any pre-F5 snapshot holding the old enemy list is still valid but has only slimes.
8. **Hash safety.** Everything hashed is a fixed-width integer (u32 owner, u8 kind, u16 id). There are no floats and no HashMap in the new code. The LOS walk uses integer division truncating toward zero. The imp lift uses integer arithmetic.
9. **F4 test filters** (`enemies.rs:157,173,193`). They only restrict the slime-specific assertions (body in Empty, floor, spacing) to slimes. The spacing between kinds is enforced by the generator's `all` list (20x20) and tested in the imp, worm and acid placement tests. The filtered enumerate index still equals the id because slimes are placed first. Acceptable, not weakened beyond intent.
