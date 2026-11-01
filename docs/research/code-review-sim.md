# Code review: sim/ (Rust WASM core)

Scope: `sim/src/*.rs`, `sim/tests/`. Read-only review; tests not run. "confirmed" = traced in code, "suspected" = depends on code outside sim/ or on a measurement not taken.
I found no reachable panic from a hostile snapshot or input (the decode paths use checked arithmetic and bounds checks, and the release profile is `panic = abort`), and no determinism hazard in iteration order or `usize` hashing.

## Findings

### 1. One Paint input can cost millions of cell writes, and nothing caps inputs per tick (high, stability, confirmed)
`sim/src/sim.rs:461-475` (`paint`), `:480-495` (`disc`), `:166-173` (`push_input`/`queue`).
Endpoints are clamped to the world and the radius to 32, but the stroke length is not. On the 2048x1536 world a diagonal `Paint` has n up to 2047 steps, and each step stamps a disc of up to ~3200 cells. That is ~6.6M `Grid::set` calls (each does `%`, `/` and neighbour wake logic) for ONE 16-byte input, on every client. `queue` is an unbounded `Vec`, so N such inputs in a tick multiply this. CLAUDE.md says a new input "needs the same bound"; the bound here limits the radius but not the product length x area.
Scenario: in any room with `brushes == 1` (sandbox, creative) a client sends a few corner-to-corner r=32 strokes in one tick. All clients stall for hundreds of ms and the room desyncs from real time. Whether the server rate-limits is outside this review, but the sim does not defend itself.
Fix: clamp the stroke to a maximum length (for example n <= 64 and step by `max(1, r/2)` so discs overlap). Add a sim-side budget of painted cells per tick (a counter reset in `step`, extra Paints ignored deterministically). Add a test that times or counts `set` calls for the worst-case stroke.

### 2. Snapshot bytes are not a canonical function of state: the `pristine` flag is history (medium, consistency, confirmed)
`sim/src/grid.rs:123-129` (`touch` clears `pristine`, even when the written value equals the old one), `sim/src/snapshot.rs:29-40` (`write` emits every non-pristine chunk), `snapshot.rs:98-118` (restore re-derives `pristine` from the snapshot).
Two clients with identical cell contents can emit different snapshots. Examples: `update_ice`, `update_acid` and `update_gas` call `set(i, same, ...)`, and a cell can be painted and then restored to its generated value. After a restore, a chunk that had been touched but ended identical to the generated world is `pristine` again on the restored client but not on the original. The state hash is unaffected (it hashes cells), so this is invisible until someone compares or dedupes snapshot bytes or hashes. Snapshot size also varies per client.
Scenario: the server or a test asserts that two clients' snapshots at the same tick are byte-equal (or caches a snapshot by hash) and gets a spurious mismatch.
Fix: decide `live` by comparing the chunk against the base (when a base is present), or make `write` emit all chunks that differ from the regenerated world. Alternatively document that snapshots are not canonical and never compare them.

### 3. Queued-but-unstepped inputs are neither hashed nor snapshotted (medium, consistency, suspected)
`sim/src/sim.rs:36-37,166-173,185-188`; `snapshot.rs::write` and `hash::state_hash` ignore `queue`.
`push_input` appends to `queue` and `step` drains it. If the host calls `snapshot_write` (or compares hashes) after pushing a tick's inputs and before `step()`, a late joiner restores without those inputs and silently diverges. The invariant is only safe if the TS driver always snapshots/hashes right after `step()` with an empty queue. I did not read the driver.
Fix: make `snapshot::write` refuse (or debug-assert) when `queue` is non-empty and expose a `queue_len()` ABI call for the driver to assert. Alternatively serialise the queue.

### 4. Hostile-snapshot validation is partial and scattered (low, stability, confirmed)
`sim/src/entities.rs:286-450` (`decode`).
Checked well: counts, ordering, enemy kind/state/hp/position, bag position, ready, lobby timestamps. Not checked: player `health <= HEALTH_MAX`, `facing <= 1`, position inside the world, `charges` (including `INFINITE` in a non-creative room), projectile position/velocity/age (`q.age += 1` wraps at 65535 in release, and `step_black_hole` adds an unclamped `vx` to `x`), `dead_until`, `round_started` bit 2+ in non-round rooms. I traced the downstream uses (`hitbox_cells`, `drop_bag`, `step_projectile`, `dig`, `wall_cast`). They clamp or bounds-check before indexing, so I found no panic, but wrapped i32 arithmetic can produce state no honest sim could reach. Snapshots come from the server, so this is low.
Fix: one `validate(&Sim)` pass after decode that asserts the same invariants the step relies on. Replace literals such as `0x7f00_0000` and `round[1] > 3` with named constants.

### 5. `round_started` is a bit-packed field whose doc contradicts its use (medium, maintainability, confirmed)
Doc at `sim/src/sim.rs:49-51` says "1 once the first kill or death has happened (D-161)". The code treats bit 0 as `ROUND_RUNNING` (`tuning.rs:345`, `sim.rs:246,289`) and bit 1 as `ROUND_BOSS_KILLED`. `entities.rs:~223` and `sim.rs:314` repeat both stories. The first-kill meaning is gone.
Scenario: the next person adds logic like `if round_started == 1` or trusts the field doc, and breaks the lobby or win condition. Related packing: the boss reuses `Enemy.state` bits 2-3 as phase and `hop_until` as a summon counter (`entities.rs:179-181`, `enemy.rs:116-140`), and `decode` special-cases both (`entities.rs:~420-428`).
Fix: split into named fields (`round_running: bool`, `boss_killed: bool`), or at least fix the docs and add `fn round_running()`/`fn boss_killed()` helpers. Add a real `boss_summons` field on the boss at the next format bump.

### 6. Entity wire format is written and parsed twice by hand (medium, maintainability, confirmed)
`entities.rs:57-130` (`Player::write`), `entities.rs:~314-345` (decode), `PLAYER_BYTES`/`ENEMY_BYTES` (hand-summed constants), `write_view`, plus `decode` mixing the `R` reader with raw `b[(fixed-4)..]` offset maths (`:296-312`).
Adding a field means editing write, decode, the size constant, the view, `FORMAT_VERSION`, and the TS reader. Nothing makes a missed one fail loudly except per-feature tests. The version history is a single 600-character doc line (`snapshot.rs:10`).
Fix: give each record `write`/`read` pairs next to each other and assert `buf.len() == PLAYER_BYTES` in `write`. Add one generic round-trip test that fills every field with a distinct nonzero value (for example via a `fuzz_player(seed)` builder) and compares after decode, so a forgotten field fails.

### 7. Adding content touches many parallel tables and if-chains (medium, maintainability, confirmed)
- Spell: `tuning.rs` arrays indexed by id (`SPELL_ENABLED`, `COOLDOWN`, `SPEED`, `GRAVITY_Q8`, `PICKUP_CHARGES`, `START_CHARGES`, `BAG_SPELL_IDS`, `PICKUP_TABLE`), the `cast` if-chain (`spells.rs:86-115`, with a hard-coded exclusion `spell != BLAST && != DIG && != WALL`), the `impact` match (`:416`), and a format bump because `BAG_SPELLS` and `NUM_SPELLS` size the snapshot records.
- Enemy: `step_enemy` is a 111-line function that special-cases worm/imp/boss by `kind` (`enemy.rs:345-460`), with `decode`'s boss-only `state_ok` and `gen.rs` spot placement.
- Material: `materials.rs` ids, `paintable` relies on `ROCK..=COAL` contiguity (`materials.rs:25`), `is_structural` (`grid.rs:9`), the volatile list in `update_cell` (`grid.rs:~335`), the dispatch match, `material_class`, and TS `MATERIAL_CLASS`. The meaning of `aux` is per-material and documented only in each update function.
Fix: a per-spell/per-enemy descriptor struct (`SpellDef { cooldown, speed, gravity, ..., behaviour: fn }`) and an enemy trait or `match kind` split into `step_slime/step_imp/step_boss` files. A material descriptor table (class, structural, volatile, flammable) would also remove the scattered lists.

### 8. Single-version restore, no migration path (low now, medium once live; consistency, confirmed)
`snapshot.rs:62` rejects any version except the current one, and `RoomConfig::decode` does the same for config. This is fine while the game is not live, but the first format bump after launch orphans every stored world. There is also no golden-bytes test pinning a v9 snapshot, so an accidental layout change under the same version passes.
Fix: before launch, add a checked-in golden v9 snapshot and a test that restores it and compares its state hash. After launch, plan N-1 readers.

### 9. Seed is not part of the state hash (low, consistency, confirmed)
`sim/src/hash.rs:34-41` hashes tick, config bytes, entities and chunk hashes. The seed drives all rng (water diagonal choice, fire life, spawn jitter) but is not hashed. In the sandbox (empty box terrain, no generation), two clients with different seeds hash identically until the first rng-dependent cell, so the first hash check can pass on a mismatched world.
Fix: add `seed` to the hashed prefix (a one-line change, but hashes change).

### 10. Magic numbers outside `tuning.rs` (low, maintainability, confirmed)
Examples: liquid `reach` 3/4/5/6 (`grid.rs:24-29`); fire life `30 + %61`, smoke `40/81`, steam `60/121` (`grid.rs:~700,740`); `GERMINATE_AT`, `ACID_STRENGTH` (`grid.rs`); `FLOOR_ROWS`, `WALL_COLS`, `h/6.clamp(20,120)`, the 16 spawn tries x 7 columns (`sim.rs:13-14,150,~265`); slime `4 * POS_ONE`, `24 * POS_ONE` (`enemy.rs:~395`); boss summon `% BOSS_SUMMON_TICKS != 150`, 5x4 pockets and 20 cells per try (`enemy.rs:122-135`); the `433/500` arena width (`gen.rs:284`).
Fix: move the gameplay-affecting ones into `tuning.rs` (or a `grid_tuning` section) with comments, so balance passes touch one file.

### 11. Oversized files and mixed concerns (low, maintainability, confirmed)
`gen.rs` 2002 lines, `grid.rs` 1679 lines (cell rules, chunk wake/sleep, island crumble, explosions, dig/carve, plus ~650 lines of inline tests from ~line 1000), `spells.rs` 899 (cast, projectiles, damage, hazard scan, respawn, bags, tests). Test modules inside the same file hide how much production code there is.
Fix: split `grid.rs` into `grid/{cells.rs, sleep.rs, islands.rs, blast.rs}` and move unit tests to `tests/` or `mod tests` files. Split `spells.rs` into `cast.rs`, `projectile.rs`, `damage.rs`.

### 12. Per-call allocation and double work in hot ABI paths (low, stability, confirmed)
`snapshot::size` is implemented as `write(s).len()` (`snapshot.rs:44-46`), so a snapshot costs two full serialisations (up to ~6MB each on a fully live L world) plus the copy. `state_hash` builds `entity_bytes()` and a fresh `buf` each call (`sim.rs:535-540`, `hash.rs`). `update_projectiles`, `wall_cast` and `alive_targets` allocate Vecs per call. None is wrong; the cost scales with player count (`MAX_PLAYERS` = 1024, and `set_active_around` is O(chunks x players)).
Fix: cache the last snapshot bytes between `snapshot_size` and `snapshot_write` (invalidate on `step`/`push_input`), or compute the size arithmetically with a debug-assert against `write`. Reuse scratch buffers.

### 13. Unbounded per-tick `queue` and `events` growth (low, stability, confirmed)
`sim.rs:36,166-173` and `events` (`EV_CAST_REJECTED`, `EV_KNOCK`, ...) are plain `Vec`s that grow with the number of inputs in a tick; `events()` copies at most `max` but the Vec itself is not capped. The memory cost is linear in inputs, which the server must bound. A sim-side cap (for example 4096 queued inputs, drop the rest deterministically) would make invariant "unbounded work per input" independent of the relay.

### 14. Tests mostly pin behaviour of the feature at hand, not whole-sim regression (low, maintainability, suspected)
Strengths are listed below. Gap: I found no golden state-hash for a scripted multi-system run (the only 16-hex-digit literal is in `tests/net/protocol.test.ts`), so a refactor that changes outcomes consistently on every client (for example reordering update_entities steps) passes Rust tests unless it breaks an assertion about a specific feature. Cross-engine equality (D2) covers platform drift, not logic drift.
Fix: add 2-3 golden scenarios (sandbox 2000 ticks; survival 3000 ticks with scripted players casting each spell) whose final hashes are checked in, updated deliberately with a DECISIONS row.

## Strengths
- Determinism discipline is real: counter-based `rng`, fixed scan order alternating by tick parity, integer-only maths with explicit `i64` for squared distances, `wrapping_*` on ticks, `isqrt` and a trig table instead of floats, no HashMap. Hashing is over fixed-width fields only.
- Sleep invisibility is designed in: `awake`/`active` are scratch, enemy and hazard logic read hashed state (players), not `awake`, and there are many D7 on/off tests including Black Hole and bags.
- Snapshot restore is defensive: overflow-checked length maths (including the wasm32 note), ordered chunk indices, exact length equality, stage-then-swap in `lib.rs::restore` so a failed restore keeps the old sim, and a dedicated hostile-bytes test for most sections.
- Per-tick work is bounded by named constants (`MAX_EXPLOSIONS_PER_TICK`, `MAX_BOMB_EXPLOSIONS_PER_TICK`, `ISLAND_WORK_MAX`, `MAX_ENEMIES_STEPPED`, `MAX_ISLAND_REMOVED`), and the island flood drains its queue each tick so no hidden state leaks.
- The Base cache is correctly treated as derived data and validated by (seed, cfg, length).
- Tuning is mostly centralised in `tuning.rs`, and doc comments say what is state vs scratch.

## Top 5
1. Paint stroke length is unbounded (up to ~6.6M cell writes per input) and the input queue has no cap (#1).
2. Snapshot bytes are history-dependent through `pristine` (#2).
3. Queued inputs are in neither hash nor snapshot; verify the driver never snapshots mid-tick (#3).
4. `round_started` doc/usage contradiction and packed fields (boss `state`/`hop_until`) invite bugs (#5), and write/decode are hand-duplicated (#6).
5. No golden hash/snapshot test and single-version restore will bite at the first post-launch format change (#8, #14).
