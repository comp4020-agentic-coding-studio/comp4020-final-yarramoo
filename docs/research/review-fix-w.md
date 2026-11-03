# Review: Brief W (woken chunks), 738ca8d..76ecdbf

Read-only review, no tests run.

## F1 MUST-FIX: `wake()` reads stale scratch `active`, so a restored client diverges
- `sim/src/grid.rs` `wake()` (about line 162) sets `woken[c]` only if `!self.active[c]`. `active` is scratch. It is recomputed in `Sim::step` at `sim.rs:201` (`refresh_active`), AFTER inputs (`apply`, sim.rs:197) and `update_entities` (sim.rs:200). `Grid::new` initialises `active` to all true, and restore builds a fresh grid, so `active` is all true after restore.
- Scenario: the server snapshots, a client joins or reconnects via restore, and the next step applies a Paint, Dig, bag or projectile terrain write, or `restore`'s `mark_chunk`, to a chunk outside the player rectangle. The continuously running client still holds the previous tick's `active` (false there), so it sets `woken`. The restored client has `active` all true, so it does not. From then on that chunk runs on one client and not on the other. This is a state hash mismatch (desync).
- Same class without restore: the player moves, so `active` changes between inputs and `refresh_active`. That is deterministic across continuous clients, but it makes the result depend on last tick's rectangle.
- The existing restore test (wake.rs:149) takes the snapshot with no input in the first tick afterwards, so it misses this.
- Fix: write `woken` from a value that is state or recomputed identically, e.g. call `refresh_active` at the start of `step` before inputs, and also after restore. Alternatively, make the restored client compute `active` from `players` before applying the first tick's inputs. Add a test: restore, then apply a Paint in a frozen chunk on the first step, and compare hashes with the continuous run.
- Confidence: high on the mechanism (code read). Whether an input or entity write can reach a frozen chunk depends on the clamps, but projectiles, explosions and enemies certainly can.

## F2 SHOULD-FIX: `set_sleep_enabled`/`wake_all` interplay (test hook only)
- `lib.rs:207` calls `wake_all` (awake all true). Then `update_woken` (grid.rs:388) sets `woken = awake` for active chunks. This is only a test hook, but a mid-run toggle can leave bits that differ from a never-toggled run for one tick. D7 compares full runs, so it is fine. Note only.
- Active, asleep (sleep on) versus run-and-quiet (sleep off) both give `awake=false`, so `woken=false` in both. I found no hole there. Confidence medium.

## F3 note: hash
- The bitset is appended only when some bit is set. A different length of hashed data means states with and without bits cannot collide in a way that matters, and the chunk-hash count is fixed. OK.
- A restored hostile snapshot with woken bits in an all-active (sandbox) world hashes differently until the first `set_active_around` clears them. Harmless.

## F4 note: snapshot
- The length check includes `wlen` with `checked_add`, padding bits are checked to be zero, and `n` is bounded. Write/restore are symmetric. Looks clean. I did not confirm `snapshot::size` includes the bitset; the test asserts it. Bits set on chunks that are active are accepted as "busy" (bounded, harmless).

## F5 SHOULD-FIX (low): falling_rock test change
- Removing acid, lava and gunpowder before the stability check is plausible, since the diff comment says those materials now eat or blow up rock in woken chunks. It does narrow the test, though. The terrain with those materials present is no longer covered. Suggest keeping a second assertion with a bounded tolerance, or one in which the hazards are present but far from rock. If generated worlds place lava beside rock, woken chunks will visibly erode terrain that previously stayed static. That is a design change, not a bug. Confidence medium.

## F6 note: bounded work
- Per-tick work is bounded by the chunk count, and `woken` is a fixed-size Vec, so no memory growth. Woken chunks holding liquid never re-freeze, so cost grows up to the whole grid in the worst case. That is the same ceiling as the sandbox, but with a larger player count than the active rectangles it can be more than designed. See the worker's load results.

## Session model's resolution (4 Nov)

- **F1 (must-fix): confirmed and fixed.** A first regression test passed because the painted "water" overwrote
  solid-box dirt and settled within the tick; repainting in an empty box (water in open air, which stays busy)
  showed the split: the running sim woke two chunks around x = 900, the restored one none. Fixed by calling
  `refresh_active()` at the start of `Sim::step`. Test:
  `wake.rs::a_write_outside_the_region_on_the_first_tick_after_restore_matches_the_running_sim`, red before,
  green after.
- **F5 (should-fix, the falling-rock test):** kept as the worker changed it. With hazards present, acid freeing
  islands is correct behaviour, so "no crumbling" is the wrong assertion for that case; a bounded hazards-on
  check is recorded in FUTURE.md.
- **Full gate on the merge of W, C, F and J:** cargo (38 binaries), clippy, typecheck, determinism 53/53, net 362
  passed (1 skipped).
- **Two real browsers** (size-S Survival room on the merged build, both ready, both moved and dug): the round
  started for both, both saw the same world a tick apart, and the server counted 78 hash checks passed, 0
  failed, no desync or resync (`docs/art/shots/merge-cfjw-two-browsers-*.png`).
