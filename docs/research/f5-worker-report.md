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

### 3. Acid slime
- `enemy.rs`: the Slime AI is shared; the acid slime hops at `ACID_SLIME_HOP_VX` 3 (Slime 5) with 15 extra ticks between
  hops. Trail: while hunting, one ACID cell in the Empty cell at its feet when `(tick + id) % 20 == 0`, with a per-tick
  budget of 1 cell across all enemies (`step_enemy` takes `&mut trail`). Death: `reap_enemies` collects burst points and calls
  the existing `burst` (made `pub(crate)`) with `ACID_DEATH_CELLS` 12 (Empty cells only). Immune to acid, hurt by fire at the
  shared rate, hp 60, contact 15.
- Gen: `floor_spots` generalised from F4's slime loop (same rules); acid slimes on deep floors between `deep_top + 20`
  and `repair_depth - 20`. Counts (`/tmp/f5-acid-counts.txt`): S 3, M 3, L 10; totals S 11-14, M 14, L 43 (under 48).
- Tests (`sim/tests/enemy_acid.rs`, 9): slower than a slime and 15 damage, trail cap (1 per tick across 6 slimes, about 1 per
  20 ticks alone, none when idle), burst cap, acid immune and fire hurt, deep placement, seed 1 real terrain (corridor around the
  generated slime, positions read from the sim), D7 with trail and burst, snapshot mid-trail.
- Red first: with the trail, burst and slower hop disabled, 2 of 9 failed (trail, burst); the slower-hop test and others
  passed because the shared AI code still reached the player in time (I left the arrival-time comparison as is: it passed
  red too, so it is a weak test, flagged).

### 4. Burrower worm
- `enemy.rs` `worm_ai`: no body collision, gravity or rescue (it lives in rock). Dormant (state bit 0 clear) until an alive
  player is within 40 cells, then awake for good. Awake: moves toward the nearest player within 120 cells (speed 2 in rock,
  4 in open; an axis moves when its offset exceeds half the other), never into Bedrock or within 4 cells of the world edge,
  and digs a radius-3 disc around its centre every stepped tick (`Grid::dig`, 49 cells). Contact 20 (shared `enemy_contact`).
  Liquids are not removed by `dig`, so a worm passes a pool without draining it; open pool cells beside a fresh tunnel flow in.
- Gen: `worm_spots`: lower half of the deep band (`(deep_top + repair_depth) / 2 .. repair_depth`), a 13x13 block of pure
  Rock around the centre (6 cells every way), off pickups, apart from others.
- **`MAX_ENEMIES` raised 48 -> 64** (flag): at L the generator now places 25 + 8 + 10 + 8 = 51 (seeds 1-3). `MAX_ENEMIES_STEPPED`
  stays 24, so per-tick work is unchanged; the cap only bounds state size and the decode check.
- Counts: worms S 3, M 3, L 8; totals S 14-17, M 17, L 51 (`/tmp/f5-worm-counts.txt`).
- Work: 24 worms all awake and stepped: exactly 24 x 49 = 1176 cells per tick (`/tmp/f5-worm-work.txt`). The test asserts equality
  to 24 * 49; a first version with only 7 worms in the rectangle (343) did not bite when I halved the bound, so the setup was
  changed until all 24 step, after which halving fails.
- Tests (`sim/tests/enemy_worm.rs`, 11): dormant and buried, wake at 39 cells, tunnels toward a player with a 7-wide tunnel,
  contact 20, lava hurts, bedrock stops it, pool, work bound, placement buried, seed 1 real terrain, D7 with chunks asleep
  while it digs, D5 mid-tunnel.
- Red first: with `worm_ai` returning at once, 6 of 11 failed (dormancy, pool, tunnel, contact, seed 1, D5); the others pass
  by nature (bedrock stop, lava, work, placement, D7 compare two identical runs under the stub). My first three setups put the player
  beyond the 40-cell wake or 120-cell hunt distance; those were fixed in the tests, not the sim.
- Gate green (exit 0).

### 4b. D2/D1/D6 script for the tiers (separate commit)
- `tiersScript()` in `tests/determinism/helpers.ts`: player 1 stands 3 cells from an imp, player 2 stands 90 cells from a buried
  worm (inside the 120-cell hunt range, outside the 40-cell wake, so the worm only tunnels once a player is in 40 cells;
  see below). Node D1/D6 asserts an enemy-owned `EV_IMPACT` (owner high bit) and a contact knock on player 2; browser D2 runs it on
  Chromium, Firefox and WebKit against Node.
- Red first: with both players moved 300/90 cells away the Node test failed ("expected false to be true"). Gate: 49 tests green.

### 5. Client
- `fx.ts` `pushEnemy` (imp with a two-frame flame flicker, acid slime with drips, worm head shown only when awake, hit flash,
  the F4 hp bar for all), `sfx.ts` (`crackle`, `screech`, `hiss`, `rumble`, `crunch`), `toasts.ts` (cause 40 + kind wording),
  `worker.ts` (per-kind hurt/death colours and sounds, enemy bolts crackle when first seen, worm rumble rate-limited to 2/s
  and only near the camera through `sfxAt`'s distance gate; `ENEMY_MAX_HP` is a render-only table mirroring `tuning.rs`),
  `room.ts` (`__devGotoEnemy(kind)`; an imp (kind 1) puts the player 4 cells above its feet, i.e. at its height).
- `chestOf`, `dropGhost` and the ghost code: enemy bolts have `q.id >= 0x80000000`, which never equals `myId` (the sim refuses
  such player ids), so no ghost is dropped and `chestOf` finds no player; the EV_CAST path is not used for enemy bolts at all.
- Test: `tests/net/toasts.test.ts` per-kind wording; red first (with toasts.ts reverted: "Received: Ana was slain by a slime").
- Gate: cargo test, clippy, typecheck, test:determinism (49) and `pnpm test:net` (312 passed) all exit 0.

### 6. Screenshots and this report
- `docs/art/shots/f5-imp-2.png`: two imps over seed-1 survival terrain, each trailing a Fire bolt toward the player, who stood at
  the imp's height in open air via `__devGotoEnemy(1)`; I looked at it and the bolts and sprites are visible.
- `docs/art/shots/f5-imp.png`: an earlier session where the same dev goto ended with "You was burned by an imp" in the death
  feed and "The party fell" with New room (the toast wording and round banner both work). Note the toast reads "You was": it is
  the existing `formatDeath` handling of the local player's name, not changed here.
- **Not captured: acid slime and worm screenshots** (ran out of tool-call budget). The acid slime and worm sprites, the worm's
  rumble and the acid hiss have only been typechecked and exercised through the sim tests.
- Vite was started by PID and killed by PID (81829, 81848, 81903).

## Counts per kind per size (seeds 1-3, from `/tmp/f5-*-counts.txt`)
| size | slimes | imps | acid slimes | worms | total |
|---|---|---|---|---|---|
| S | 7/8/5 | 3 | 3 | 3 | 14-17 |
| M | 8 | 3 | 3 | 3 | 17 |
| L | 25 | 8 | 10 | 8 | 51 |

## Work-count maxima
- Slime-only worst case (F4): 3600 cells/tick with 24 stepped.
- 24 awake worms: exactly 1176 cells/tick (24 x 49).
- Imp line of sight: at most 120 steps per imp per 15 ticks (tests assert the length limit, not a measured maximum).
- Acid trail: at most 1 cell per tick (asserted with 6 slimes). Death burst: at most 12 cells.
- I did not run a combined worst case of all four kinds at once (the stepping cap of 24 bounds it).

## Not verified
- Acid slime and worm in a browser (see above). Imp and worm sounds were never listened to.
- No cross-check that a worm can never breach into a region that breaks `traversable_to_every_band`: the worm only removes
  Rock/Dirt/etc. (`Grid::dig`), so it only adds open space, and it cannot dig bedrock; placement asserts pickups are clear at spawn
  only, a tunnelling worm can pass through a pickup cell (pickups are entities, not cells, so nothing is destroyed).
- The acid-slime "slower" test passes red too (see commit 3), so it is weak.
- The slime-only D2 script from F4 still passes unchanged, but the two F4 placement tests were filtered by kind.

## Architectural decisions for review
- **Enemy-owner id scheme.** `owner = 0x8000_0000 | kind << 16 | enemy id`. Alternatives: a separate `enemy_owner` field on
  `Projectile` (a format change to the projectile record and the view), or ids from a counter. Chosen because the design
  (section 11, item 4) said so and it costs no format bump. `Sim::join` refuses ids with the bit set, and `decode` rejects unknown kinds and
  reserved bits. Cost for the boss slice: the boss's own bolts fit (kind 4 needs `NUM_ENEMY_KINDS` 5 and more kind bits are free:
  kind has 8 bits); but the 16-bit id caps enemies at 65535, fine.
- **Enemy bolt cap.** 16 in flight in total (`MAX_ENEMY_PROJECTILES`), refused silently at the cap, plus the global 256. They do not
  count toward a player's 12. Alternative: per-enemy cap. Chosen as simplest and bounded; a boss volley of 3 bolts every 90 ticks fits.
  Cost: with many imps firing, extra shots are dropped, not queued (the imp does not start its cooldown when refused, so it retries on its next LOS tick).
- **Line of sight cost and cadence.** One straight-line walk of at most 120 cells, per imp, only when `(tick + id) % 15 == 0` and the
  imp is off cooldown and within range. Worst case 24 imps x 120 / 15 = 192 steps per tick average. A truncating-division line, not
  an exact Bresenham, and diagonal corner-cutting is allowed (a bolt then stops on the corner). Cost later: the boss will want
  a precise aim; reuse `line_clear`.
- **Flier collision.** The imp uses the walker's `integrate` (box against grid, x then y, wall slide) with step-up off and no gravity;
  velocity eases 1 per tick toward the wanted one. Alternative: no collision (ghosts through rock). Chosen to match the brief. Cost:
  an imp can get stuck against a wall with no steering around it (it only pushes toward the target); acceptable for caves with open pockets.
- **Worm digging.** `Grid::dig` radius 3 at its centre every stepped tick (49 cells), no body collision (it lives in rock) and no gravity.
  Liquids and fire are not removed, so a worm passes through a pool without draining it, and open liquid beside a new tunnel flows
  in (flooding is fine and untested beyond the pool test). It cannot dig Bedrock or within 4 cells of the world edge. Dormant until 40 cells, then it hunts for good
  within 120 cells (it stops, still digging in place, when no player is within 120). Alternative: dig only a path ahead. Cost: a stationary awake
  worm re-digs the same disc each tick (no-ops after the first), and a worm that is frozen outside the stepping rectangle stays where it is.
- **`MAX_ENEMIES` 48 -> 64.** Needed: L places 51. The stepping cap of 24 is unchanged, so per-tick work is the same; only state size grows
  (35 bytes each, 64 x 35 = 2240 bytes). Test `full MAX_ENEMIES is accepted` still uses the constant.
- **Kind-specific code in `step_enemy`.** The imp and worm branch off before the slime path, sharing `integrate` and `enemy_contact`. The
  boss should do the same rather than extend the slime path.
- **`ENEMY_MAX_HP` mirrored in the client** (`worker.ts`), render-only; a test pinning it to `tuning.rs` was not written (cost: drift).

## FUTURE.md ideas (suggested only)
- Imps steer around walls (a wall-following or probe step) instead of pushing straight at the target.
- A worm that leaves a visible rumble tell (screen shake or particles at the rock face) before it breaks out.
- A test that pins client `ENEMY_MAX_HP` to the sim's `ENEMY_STATS` through the shared TS names file.
- Worm tunnels refilled by loose rock settling (a slow "collapse") so a descent is not one open highway.
