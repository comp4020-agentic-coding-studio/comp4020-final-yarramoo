# Review: M5 slice 3 (bags and format 3)

Scope: `git diff 567dcbd..3291ce1`. Method: read the diff and its callers, ran `sim/tests/bags.rs` (20 pass) and
`tests/net/entity-layout.test.ts` (3 pass), and mutation-checked the tests in a throwaway copy of `sim/` under `/tmp`
(deleted afterwards; the working tree was not touched by me).

Counts: S 0, N 2, M 6.

## Findings

### N1. D-111's "falls back to the log" is false (docs claim; the behaviour is a reset)
`docs/DECISIONS.md` D-111 and `docs/engineering-decisions.md` section 17 say "a refused stored snapshot already falls back
(a failed `hashOf` in the build-change path resets the world; `loadFromDb` otherwise replays the log from tick 0)" and "a
refused game snapshot falls back to log replay ... the path for a corrupt row".

Code, `server/world.ts:252-270`:
```
if (row.simBuild !== this.simBuild) {
  ...
  if (snap && this.verifier) ok = (await this.verifier.hashOf(...))?.tick === snap.tick;
  if (ok && snap) { db.clearTickLog(...); ... "kept_snapshot" }
  else { db.resetWorld(this.id, this.simBuild); snap = null; ... outcome: "reset" }
}
const base = snap ? snap.tick : 0;
```
`resetWorld` (`server/db.ts:150-160`) deletes every snapshot and the whole tick log. Nothing is replayed, and the world
restarts at tick 0. The build-change path never replays the log (`clearTickLog` on the kept path, wipe on the reset path).
The "otherwise" path (same `simBuild`) does not verify the snapshot at all: it loads `this.snapshot = snap.data` and
serves it to joiners. It never drops a bad snapshot and never goes back to the log. So the claim is wrong in both halves.

Practical effect today is fine (no game snapshot exists, and `simBuild` changes with the wasm, so the same-build path
cannot meet a v2 snapshot). The outcome for a v2 game world is "reset", which D-111's rationale ("lost on deploy, accepted")
already tolerates. Fix: reword D-111 and section 17 to "a refused snapshot makes `hashOf` return null, and the
build-change path then calls `resetWorld`; there is no log fallback". Also drop the "already the path for a corrupt row"
sentence in section 17.

### N2. The compat promise for the live sandbox depends on `hashOf` succeeding; any failure wipes it (D-014)
Same code as N1. For the sandbox (kind 0) on a deploy, `ok` is false if `this.verifier` is undefined, the worker times out
(`server/verify.ts:69-78` resolves null), or the worker is busy past its timeout. Then `resetWorld` deletes the sandbox's
snapshots and log, which D-014 forbids. The slice changes the format that this path must accept, so the Rust side being
right (v1 to v3 sandbox restores) is necessary but not sufficient. Pre-existing, but D-111's compat argument does not
mention it. Fix: in the build-change path, treat a null `hashOf` for a sandbox as "keep the row, retry or fail startup"
rather than reset. At minimum, log and refuse to boot rather than delete. Not blocking for this slice.

### M1. Bag view id is the vector index (`sim/src/entities.rs:414`)
`put(ENT_BAG, i as u32, ...)`. When an earlier bag is picked up, expired or evicted, every later bag's id shifts, so a
client keyed on `id` sees bags "teleport" or swap. The doc comment says it, so it is deliberate, but cheap to fix later
(for example key on `(x, y, expires_at)`, or hand out a monotonic id). Log in `FUTURE.md` or fix before the client work.

### M2. Decoder accepts bag sets the sim could never produce
`entities::decode` (`entities.rs:305-316`) checks counts, exact length, in-world x/y and non-zero charges. It does not
check that bags are pairwise farther than 8 cells apart, that charge slots are below `INFINITE`, or that `expires_at` is
sane. A crafted snapshot with two bags on one cell, or `charges = [65535,..]`, restores. It does not panic: `drop_bag`
and the pickup both use `saturating_add(..).min(INFINITE - 1)`, and `total()` widens to u32 first. So it is a validity
gap, not a trap. A bad snapshot already needs the hash vote to pass, so this is low risk. Fix if wanted: reject
`INFINITE` in bag slots.

### M3. Decoder: checked as safe (listing what I verified)
All sizes are computed in u64 (`fixed`, `bag_at`, `nb * BAG_BYTES`). `np <= MAX_PLAYERS`, `tail <= MAX_PROJECTILES` and
`nb <= MAX_BAGS` are checked before any allocation (`with_capacity(nb)` is at most 64). Slice indexing at `fixed-4` and
`bag_at` is guarded by the preceding length checks, and the casts to `usize` follow `<= b.len()`, so there is no wasm32
wrap. The total length is pinned exactly, so there are no trailing bytes. Every field read goes through `R::take`
(checked add), and the outer `snapshot::restore_with` uses `checked_add` for `eend`. I found no panic path. Tests
`hostile_bag_bytes_fail_cleanly` cover the count, length and coordinate cases and would fail if those checks went.

### M4. Expiry is wrapping-tick fragile
`expires_at = tick.wrapping_add(BAG_LIFETIME)` with `tick < expires_at` (`spells.rs`, `update_bags`). Within 5400 ticks
of the u32 wrap (about 2.3 years of runtime) a new bag would expire at once or never. Same class as other `wrapping_add`
uses in the codebase, so not new. Ignore unless a world can really run that long.

### M5. Merge restarts the expiry timer
A bag within 8 cells of repeated deaths can be kept alive forever by feeding it a charge (`b.expires_at = expires_at`).
Intended by D-109 ("its timer restarts"), but a spawn camp near a bag never expires it. Note for tuning, not a bug.

### M6. Test hygiene
- `sim/tests/bags.rs:~386` has a mis-indented `let mut r` and a dead `let _ = base;` in the D5 test.
- No Rust test kills a player through the real `step()` hazard scan or explosion path and checks the bag's tick and cell.
  The only such coverage is the TS `entity-layout` test (lava death), and it checks the count and offsets, not the tick.
  `kill()` calls `explode_at` directly, which is the same `apply_damage`, so the drop logic is covered, but not the ordering
  against `update_bags` (a death in step 2 gets one fall and a pickup check on the same tick; a death in steps 5 or 6 waits
  until the next tick).

## Checked and found fine

- **Iteration order.** Bags are a `Vec` kept in spawn order. `retain`, `remove(0)` and `remove(i)` all keep order. Merge uses
  `position` (first in vector order), so every client picks the same bag. Pickup loops players (sorted by id, binary-search
  inserted) outside and bags inside. No `HashMap`, floats or `usize` in the hashed bytes (`BAG_BYTES` is a count only).
- **Native vs wasm32.** Coordinates are u16, charges u16, tick u32; hashed bytes are fixed-width LE. `cell.0 as u16` is safe
  after the clamp to `0..w-1`.
- **Death placement.** Feet cell is `(x >> 4, (y >> 4) - 1)`, clamped. A death in lava puts the bag in a liquid cell where it
  never falls (D-109 accepts this). Two deaths at one spot in one tick merge into one bag. Respawn runs before `update_bags`,
  so a respawned victim standing on the bag takes it the same tick. Test `the_respawned_victim_takes_their_own_bag_back`.
- **Saturation.** `saturating_add(..).min(INFINITE - 1)` in both merge and pickup, and pickup skips `INFINITE` slots.
- **Cost bound.** At most 64 bags, a few reads each; pickup is at most `players x bags` (1024 x 64) comparisons a tick, only
  when bags exist. It is bounded and needs no new input limit (deaths are not inputs).
- **Sleeping.** The fall only reads `grid.mat[(y+1)*w+x]`, never writes, and bag state is outside the grid, so a sleeping
  chunk cannot change the result (the grid's own invariant 8 makes cell contents the same on or off). Bounds: `y + 1 < h`,
  `x < w` (decode enforces it). Mutation: gating the fall on `grid.awake[chunk_of(x, y)]` made both
  `sleeping_is_invisible_to_falling_bags` and `a_bag_falls_through_empty_and_gas...` FAIL, so the sleep test does bite.
  (It does not exercise a changing cell below a bag in a sleeping chunk, but nothing in the rule depends on that.)
- **D5 snapshot test mutation.** Making restore add 1 to `expires_at`, and making restore drop the bags, each FAILED
  `d5_snapshots_with_bags_and_a_dead_player_continue_identically` (and the round-trip tests), so it is not tautological.
  A merge using `rposition` instead of `position` FAILED `merge_picks_the_first_bag_in_order...`.
- **Format 3 compatibility (Rust side).** `restore_with` accepts 1..=3 for kind 0 with an empty entity section, refuses
  a game snapshot below 3 and anything above 3. `v2_sandbox_restores_but_v1_and_v2_game_snapshots_are_refused` checks
  that. The state hash excludes the header, so stamping v3 on sandbox snapshots changes no hash. The `compat.test.ts` DATA
  claim uses a real fixture from the deployed build and is unchanged in the diff. (Caveat: there is no real v2-written
  fixture; the v2 case is a v3 sandbox snapshot with the version bytes edited. That is equivalent because a sandbox's
  entity section is empty in every version.) I did not run `compat.test.ts`.
- **`server/db.ts`.** `SNAPSHOT_FORMAT_VERSION` is only written into the `format_version` column. Nothing reads it back, so
  compatibility is decided solely by the sim's `restore` via `hashOf`.
- **`activePlayersIn` and the layout test.** Players stay first, so the server's fixed-offset read is unaffected.
  `entity-layout.test.ts` now walks players, pickups, projectiles and bags and requires `o + 4 + nb * 16 == elen`, so a
  reordering or a size change of the bag record fails it. Passes on a real lava death with a bag.
- **Events and view.** `EV_DEATH.c` is `dropped as i32`; `EV_BAG_PICKUP` total is clamped to `u16::MAX`. The view total is
  clamped likewise. 1024 + pickups + 256 + 64 fits `MAX_ENTITIES = 1600` (asserted in the test).

## Resolution (fixed by the orchestrating session)

- **N1 fixed:** D-111 and engineering-decisions entry 17 now say a refused game snapshot resets the world on a build change, with the correction kept visible.
- **N2 fixed (D-112):** start-up uses `SnapshotVerifier.check`, which separates "refused" from "unavailable"; only "refused" resets, and "unavailable" refuses to start. New tests in `tests/net/persistence.test.ts` ("a new sim build at start-up"): the hung-verifier case failed on the old code and passes now; the kept and reset cases pass on both.
- **M1–M6** left: view ids are only used for rendering this frame (M1); hostile-but-harmless bag contents don't break determinism (M2); expiry wrap needs ~2.3 years of ticks (M3); bag timers refreshing on merge is the designed behaviour (M4); M5 is covered by slice 5's coverage work, which drives deaths through real `step()` scripts; M6 is cosmetic.
