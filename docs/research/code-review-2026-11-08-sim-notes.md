# worker1-sim review: grid.rs, entities.rs, enemy.rs, spells.rs, gen.rs (skim), rng/hash/trig
Code only; nothing run. Line numbers are from the working tree at branch multa (7d5b004).

## Findings

### 1. [medium] sim/src/grid.rs:975-978 (update_ice): aux decrement without touch(i), stale chunk-hash cache
```
self.set(ny * self.w + nx, ICE, 1);
self.moved[ny * self.w + nx] = 1;
self.aux[i] -= 1;          // <- no self.touch(i)
return;
```
`set(n, ..)` only dirties `dirty_since_hash` for chunk(n) (touch marks dirty on the cell's own chunk, and only
`wake`s the neighbours; wake sets `awake`/`woken`, not `dirty_since_hash`). When ice cell `i` is on a chunk edge
and the freezing Water `n` is across it, chunk(i)'s aux changes but its cached hash stays valid. Every other aux
write in grid.rs is followed by touch(i) (acid 806, thermite 951, coal 997, fire 1122, gas 1160, seed 1193), so this
is the one miss.
Failure: state_hash (hash.rs chunk_hashes) uses `hash_cache`. A client that played through hashes the stale chunk;
a client that joined from a snapshot (restore calls mark_chunk on every serialised chunk, so it hashes true
content) hashes the real aux. Result: spurious hash mismatch for a late joiner at the next hash check, and any
later real divergence in that chunk's aux is invisible until something else touches the chunk. Needs ice with
budget at a chunk edge and water across it (ice biome halls, ICE_COLD budget 3), so rare but reachable.
Confidence: code path VERIFIED; the observed mismatch SUSPECTED (not run).
Fix: add `self.touch(i);` before the return (one line). Then add a generic invariant test: after N ticks of the
perf_equiv/sleep scenarios, `state_hash()` must equal the hash after `for c in 0..chunk_count { mark_chunk(c) }`
(perf_equiv's `planes()` hashes raw planes separately but never compares against the cache).

### 2. [low] sim/src/entities.rs:324-517 (decode) does not validate projectile / player coordinates or cell bytes
Players x,y, projectile x,y,vx,vy,age are taken raw. Consequences in release wasm are only wrap-around (no
overflow checks), so wasm and native-release agree; but `q.age += 1` (spells.rs:354, u16, age 65535 wraps to 0 and
gives the bolt another 180 ticks), `x0 + q.vx*k/n` and `Player::hitbox_cells` can overflow/panic in debug
(native `cargo test` debug) and so differ from release. The snapshot source is the server/another client, so a
hostile snapshot is the only trigger. Restore also never validates `mat` bytes (unknown ids are inert) or SEED aux
(`self.aux[i] + 1`, grid.rs:1191, wraps in release). Cheap hardening: reject projectiles with x/y outside the
world<<PROJ_SHIFT, age > PROJ_MAX_AGE (BH_LIFETIME for black holes), players outside the world, mat >= NUM_MATERIALS.
Confidence: VERIFIED absent; exploitability SUSPECTED (depends on whether the server relays untrusted snapshots).

### 3. [low] sim/src/grid.rs:167-195 + 575-: `touch` does two integer divisions per call and 9-way wake logic on every swap
`touch(i)` does `i % self.w`, `i / self.w` (runtime divisor) then up to 9 `wake` calls; `swap` calls touch twice,
so each moved cell costs 2 divides + ~20 branches + 4 Vec writes. This is the hottest path in the sim. World widths
are 512/1024/2048 (config.rs SIZES), always powers of two; storing `w_shift` (or passing x,y from the caller, who
already has them) removes the divides. Cost: moderate (a few percent of a busy tick); no correctness risk.
Confidence: VERIFIED (code); magnitude SUSPECTED (not profiled).

### 4. [low/medium] sim/src/grid.rs:47-111 Grid::new: ~28 MB of scratch per Sim at 2048x1536
`island_stamp: vec![0u32; w*h]` and `island_anchor: vec![0u32; w*h]` are 12.6 MB each at L, plus `moved` 3 MB,
plus mat+aux 6 MB, plus `Base` copies (mat/aux clone, sim.rs:~144) and the 12.6 MB `ps` prefix-sum table that
gen's box_reach allocates per call. Stamps are used only inside crumble_islands, which touches at most
ISLAND_WORK_MAX (4000) + 16*121 cells per tick. On wasm32 (4 GB cap but real devices smaller) and per world instance
this is wasteful. Fix: a small open-addressed visited set (or a Vec<u32> of touched indices to reset after each pass)
sized for 4000-6000 entries; or u16 stamps with per-pass reset of just the touched cells. Confidence: VERIFIED.

### 5. [low] sim/src/gen.rs:2375 box_reach_to / depth_reaches: full prefix-sum rebuild on every call
`box_reach_to` allocates `(w+1)*(h+1)` u32 (12.6 MB at L) and `seen` (3 MB) and does a 3M-cell pass each call;
`depth_reaches` is called per site in `carve_sites`, `fill_lava_lakes` (per lake attempt), `place_biome_halls`
(up to 3 per site on the fallback path, which also clones mat+aux and calls `stranded()`, another 3 MB alloc + flood).
Generation runs on every client join (unless the Base cache hits), so this is join latency, and the Survival boss
logic depends on it. The repo has an ignored measurement test (`measure_gen_time_and_pickups`) but no budget
assertion. Fix: reuse one scratch (ps, seen) across calls via a struct, or maintain an incremental check; add a
time-free work-counter assertion (cells scanned) to catch regressions. Confidence: cost SUSPECTED (not measured);
allocation pattern VERIFIED.

### 6. [low] Hot-loop allocations per tick (sim.rs/spells.rs/enemy.rs)
- spells.rs:272, 318-326: `boxes: Vec<Box5>` built every `update_projectiles` / `wall_cast`; `gone` Vec per tick.
- enemy.rs:463-479 `stepping_set` returns a fresh Vec and is called twice per tick (update_enemies and
  enemy_hazard_scan), each also calling `alive_targets()` (another Vec); sim.rs:361 `refresh_active` builds a Vec
  of centres and runs twice per tick; grid.rs:384 `fall_step` `keep = Vec::new()`.
- grid.rs:219 `set_active_around` is O(chunks * players) twice per tick (768 chunks * up to MAX_PLAYERS=1024).
All small versus the cell pass, but they are avoidable (reuse scratch Vecs on Sim/Grid; compute the stepping set once
per tick and share it). Projectile stepping is O(projectiles * substeps * (players+enemies)): 256*8*(1024+64) = 2.2M
checks worst case at MAX_PLAYERS; fine for real rooms but the cap is far above what the loop is sized for.

### 7. [low] sim/src/grid.rs:354 fall_one: blocker scan per island cell
`self.fall_blockers.iter().any(..)` runs for every below-cell of every falling island: <=16 islands * <=120 cells *
(players + enemies <=1088) worst case ~2M per tick; typically ~100k. Bound is fine but could early-out by testing the
island's bounding box against the blocker list once. Confidence: VERIFIED.

### 8. [low] sim/src/rng.rs:128-148 salt reuse between sim and generator (260-267)
SALT_MUD_MOVE..SALT_QUAKE (260-267) share values with SALT_GEN_BIOME..SALT_GEN_MUSH. Harmless today because gen
always passes tick 0 and different x/y semantics, but nothing enforces uniqueness; a future gen salt that collides with
a runtime salt at tick 0 would correlate draws silently. A const-array uniqueness test (separately for gen and
runtime salts) would pin it. Confidence: VERIFIED.

## Things checked and found sound (so nobody re-checks them)
- Chunk sleeping completeness: every rule that is not provably idle on an unchanged 3x3 neighbourhood sets vol_seen
  (FIRE/SMOKE/STEAM/SEED/ACID, growing STEM, primed GUNPOWDER, lit COAL, lava near flammables/coal/ice/sand or with a
  move, mud waiting its turn, snow with snow above, salt by ice/water, ice by water with budget, lit thermite).
  `slide` reads up to 6 cells sideways, but it only runs when an adjacent side cell is open (so the decision is
  3x3-local; only the destination is far). Snow's 3-up read and seed's 2-radius wet read are covered (volatile).
- Frozen/woken/active bookkeeping (step_cells, update_woken, restore starting with awake=all true, active derived at
  the top of step()): equivalent for a restored and a played-through client; tests (sleep.rs, wake.rs,
  falling_islands.rs mid-fall restore) cover it.
- Falling islands: flood/stamp scheme, bounded work (ISLAND_WORK_MAX, FALL_MAX_ISLANDS, MAX_ISLAND_REMOVED), unique
  island_cells so `sort_unstable_by` is deterministic, falls list hashed+snapshotted with validation on restore.
- All fixed-width state in entities encode/decode (no usize), counts validated before allocation, exact-length
  check, sorted-id checks. hash.rs uses u64 LE and appends falls/woken only when non-empty.
- Integer math: dig/carve/explode/knockback use i64 where products grow; `/` of negatives only on values whose
  truncation is the same on every target (Rust semantics are fixed), shifts of negatives are arithmetic everywhere.
- Enemy id handling: placed ids are indices, boss gets the highest, summons use `boss.id + 1 + summons` (counter only
  grows), so ids never repeat; vec stays id-sorted; indices from `stepping_set` stay valid because step_enemy only
  appends.
- Input cost bounds: paint clamps, dig clamps radius+reach, quake/freeze/burst/wall have fixed boxes, explosions
  capped at 256/tick, bombs capped per tick, projectile counts capped.

## Improvements (not bugs)
- (medium) Split grid.rs (2148 lines): storage+chunk metadata, `rules.rs` (the ~800 lines of per-material updates),
  `islands.rs` (flood/fall/crumble), keep tests next to each. gen.rs (2895 lines) splits naturally by phase
  (terrain/worms, sites/biomes, pools, decoration, spots).
- (small) enemy.rs repeats the "nearest target by squared distance" loop six times (imp_ai, wisp_ai, boss_ai,
  colossus_ai, worm_ai, step_enemy) and the boss/colossus phase-from-hp computation twice; extract
  `nearest_target(targets, e, y_off)` and `phase_for(hp, max)`. step_enemy's per-kind `... self.enemies[i] = e; return;`
  chain could be a match returning a post-step flag set.
- (small) Player hitbox `Box5` list is rebuilt in three places (wall_cast, update_projectiles, sim.rs fall_blockers);
  compute once per tick on Sim (scratch) and reuse.
- (small) Add the invariant test from finding 1 (cached hash == hash after mark_all_dirty) to every sleep/perf_equiv
  scenario, plus a decode hostility test for projectile/player coordinates (finding 2).
- (medium) Snapshot size: any touch makes a chunk non-pristine for good (grid.rs:171), so a played world serialises
  most of mat+aux (up to ~6 MB) and `snapshot::size` calls `write(s).len()` (builds the snapshot twice per fetch;
  lib.rs side). Keeping a pristine check by comparing against Base, or caching the last write, would cut this.
- (small) A sentinel `usize::MAX` appears in gen.rs box_reach (not hashed, so safe), but note it is 32-bit on wasm32.

## Looks good
- Disciplined determinism: counter-based rng everywhere, no float, no HashMap, explicit tie-breaks (`min_by_key` with
  coordinates) in the generator, `wrapping_add` on ticks, saturating arithmetic on charges.
- Scratch-versus-state is documented per field in Grid (awake/active/moved scratch; woken/falls state) and the
  snapshot/hashing follows it, including the "append only when non-empty" trick that kept old hashes stable.
- Tests are strong around the riskiest code: sleep on/off equivalence per material group, mid-fall snapshot
  restore, hostile falling-list and count rejection, bounded-work tests for flood/paint/dig, golden fixture.
- Bounded-cost design is consistent: every input-triggered loop has a named constant cap.
