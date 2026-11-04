# Sim performance audit, 5 Nov 2026

Read-only audit of `sim/src` (plus the client frame path). No code changed. **No benchmarks were run**: the machine was loaded by other agents, so
every cost below is either an existing measurement (cited) or an estimate from reading the code, and is marked as such.
Baselines used: `g2-results.md` (P1 bench native p50/p95 2.4 / 2.8 ms after the liquid-rng fix, about 0.03 ms per awake chunk; before it
the figure was about 0.11 ms per chunk), `wake-load-results.md` (steady p95 about 4.4 ms native after many floods; 2x wasm ratio is an estimate).

Headline: the step is dominated (over 95%, g2-results) by the cell pass over awake chunks. Everything else per tick is small. The big wins are
therefore in the per-cell path, and the cheap ones are `touch` and the wasm build. Nothing here needs a design change.

## Ranked table

| # | Finding | Where | Est. gain | Changes results? | Effort | Class |
|---|---|---|---|---|---|---|
| 1 | `touch` recomputes `i % w`, `i / w` (runtime divisors) and `chunk_of` (two more divisions) on every `swap` (twice per move), then up to 9 `wake` calls. Pass or derive x,y once; skip the neighbour wake unless the cell is on a chunk edge (already conditional, but the divisions are not) | grid.rs:133, :330 | est. 5-15% of the cell pass in a busy flood (8 integer divisions per moved cell; wasm32 div is about 20-40 cycles) | No (same writes, same order) | small | Quick win |
| 2 | Build: `codegen-units` left at default, no `wasm-opt`, no `-C target-cpu`/simd. Set `codegen-units = 1`, run `wasm-opt -O3` on the output in `build:sim` | sim/Cargo.toml, package.json:11 | est. 5-15% overall; wasm-opt must keep imports at zero (D10 checks) | No results change; **changes the sim build hash**, which is intended (all clients and the server take the new wasm together) | small | Quick win |
| 3 | `snapshot::size` calls `write(s)` and `snapshot_write` calls it again: two full builds, two allocations of up to about 6 MB (768 live chunks x 8 KB) per snapshot | snapshot.rs:47, lib.rs `snapshot_size`/`snapshot_write` | halves the snapshot cost (a 6 MB build is about 2-4 ms native, a spike once per checkpoint, not per tick). Cache the buffer from `snapshot_size` and hand it out in `snapshot_write` | No | small | Quick win |
| 4 | `step_cells` clears the whole `moved` plane every tick (3 MB at L) even if few chunks run | grid.rs:341 | measured 0.11 ms at 2048x1536 (g2-results): 1-3% of a busy step but about 100% of an idle step. Replace by a per-cell u8 tick stamp (`moved[i] == tick as u8` style, with a periodic clear) or clear only chunks that ran and their neighbours | No if done right (flag semantics are tick-local), but a stamp bug is silent: needs D1/D7 | medium | Medium |
| 5 | Quiet-cell cost inside an awake chunk: every one of the 4096 cells calls `update_cell`, which reads `moved[i]`, then `mat[i]`, then runs the volatile `matches!` before the big `match`. Empty and inert cells (most of a chunk) pay the `moved` read and a 9-way compare. Test `m == EMPTY \|\| is_inert[m]` first via a 256-entry `const` lookup table, hoist `moved` check after it | grid.rs:400-440 | est. 10-25% of an awake chunk that is mostly air or rock; no gain on a dense flood | No: pure reordering. But the `moved` branch sets `vol_seen = true` and must keep doing so for non-inert cells | small-medium | Medium |
| 6 | Row-order scan with per-cell `x` recomputed from `odd`, `cx`, bounds-checked `self.mat[i]`, and `off()` doing four isize compares per neighbour probe. Interior cells (not on a world edge) could use unchecked neighbour offsets; or split the chunk into an interior fast path | grid.rs:365, :447 | est. 10-20% in liquid/powder-heavy chunks; the borrow checker will keep the bounds checks unless indices are proven | No if the fast path is exactly equivalent | medium | Medium |
| 7 | Liquid sideways search: `slide` loops to `reach` cells, each with two `off`+`ok` probes. Already gated: the rng is drawn only when both sides are open, and resting liquid on bare ground returns before searching (`liquid_free`) | grid.rs:516-596 | Already done; remaining cost is bounded by `reach`. Not worth touching | n/a | n/a | Checked, fine |
| 8 | Per-cell rng is 3 `mix` rounds (about 6 multiplies). It is only drawn when a decision needs it for liquids; powders draw on every diagonal attempt | rng.rs:10, grid.rs:507 | Powder draw could be skipped when only one diagonal is open, like liquids already do (identical results, as g2-results showed). est. 3-8% in a sand-heavy scene. Cheaper mixing would change every result | Skip-when-forced: No. Cheaper hash: **high** (format break, all goldens) | small / high | Quick (the skip) / Only if needed |
| 9 | `moved`, `mat`, `aux` are separate planes: a swap touches 4 arrays. Interleaving would hurt the 1-byte planes shared with hashing, upload and snapshots | grid.rs:330 | not worth it; the client uploads and hashes the planes directly | n/a | high | Not worth it |
| 10 | `refresh_active` runs twice a tick: `set_active_around` is chunks x centres compares (768 x up to 8) and one `Vec` allocation each time | sim.rs:339, grid.rs:185 | Measured 0.005 ms (g2-results). Not worth changing; the second call is a correctness fix (review W F1). Reusing the `centres` Vec saves two tiny allocations | No | trivial | Checked, fine |
| 11 | `update_woken`, sleeping: `active.iter().all()` twice per tick, a linear pass over chunks, all O(chunks) | grid.rs:340-398 | under 0.01 ms; idle 4-player world measured p95 0.3 ms native. Fine | n/a | n/a | Checked, fine |
| 12 | Hashing: `state_hash` is called every `HASH_EVERY` = 60 ticks (client/lockstep.ts:147), not every tick, and rehashes only chunks that `touch` marked dirty (hash.rs:19). `state_hash` builds a `Vec` of tick+cfg+entities+chunk hashes (768 x 8 B = 6 KB) and `chunk_hashes` copies them out | hash.rs:34 | one burst a second: about 70 dirty chunks x 8 KB through xxh3, est. 0.05-0.2 ms. Fine. Note that `touch` marks a chunk dirty on any swap even if the cell returns to its old value, so a busy flood rehashes all awake chunks; harmless | n/a | n/a | Checked, fine |
| 13 | Entities: `stepping_set` and `alive_targets` allocate a `Vec` per tick; enemies capped (`MAX_ENEMIES_STEPPED`, `LOS_MAX_STEPS`, LOS only every `IMP_LOS_EVERY`); `enemy_blocked` is at most about 20 cells; `hazard_scan` is the player hitbox only. `crumble_islands` returns at once when nothing was removed and is bounded by `ISLAND_WORK_MAX`; island_stamp/anchor use a tick stamp so no per-pass clear | enemy.rs:308, grid.rs:236 | negligible (under 0.05 ms by count of work); no O(n^2) found. Reusable buffers would remove 3-4 small allocs a tick | No | trivial | Not worth it unless allocator shows in a profile |
| 14 | Client upload: only the camera window of `mat` and `aux` is uploaded per frame (about 0.13 MB), `dirty_rects` is a stub returning 0, no whole-grid copy | render.ts:362 | Already done | n/a | n/a | Checked, fine |
| 15 | Client `updateSurface`: walks each visible column down from the top with stride `ww` (cache-hostile), about 100k reads, every 12 frames or when the window moves sideways. Cheaper: remember the last surface and only rescan columns whose chunks were touched, or scan a coarse row-skip | render.ts:277 | est. 0.2-0.5 ms on the main thread, on every 12th frame and on each horizontal scroll (so every frame while walking); this is outside the sim but shares the frame | n/a (render only) | small | Medium |
| 16 | Parallelism / SIMD of the cell pass | | wasm threads banned (invariant 11); simd128 only helps `fill` and hashing | n/a | n/a | Not allowed / not worth it |

## Detail

### 1. Cell loop (`grid.rs`)
- Traversal is chunk by chunk, rows bottom to top inside the chunk, x direction alternating by tick parity. Memory access is row-contiguous within
  a 64-wide strip; a 64-byte strip per row per plane stays in L1, so locality is fine. No change proposed.
- Index arithmetic is `usize` (32-bit on wasm32, so no penalty there). `off()` returns `Option<(usize, usize)>` and every probe does
  four signed compares, then `at()` recomputes `y * w + x`. LLVM will not hoist `y * w`. Cheap rewrites with identical behaviour exist (compute `i`
  once and test x/y only at world edges), see finding 6.
- A chunk is skipped as a unit (`awake`/`active`/`woken`), which is cheap. Inside an awake chunk there is no per-cell skip (finding 5).
- `touch` (findings 1) is the one clearly avoidable cost: a swap calls it twice, each doing `i % w`, `i / w`, `y / CHUNK`, `x / CHUNK`, `c % cw`,
  `c / cw` with non-constant divisors (`CHUNK` is const, the others are not). Carrying (x, y) from the caller removes six of eight divisions.
- Liquids: rng is already deferred until both sides are open (landed after P1); the slide is bounded by `reach` (finding 7).

### 2. Chunk activity
All O(chunks) and tiny (findings 10, 11). The only per-tick cost with nothing happening is the 3 MB `moved.fill` (0.11 ms measured) plus the chunk
loop: idle p95 0.3 ms native with 4 players (g2-results). Finding 4 would remove the fill.

### 3. Hash and snapshot
See findings 12 and 3. The hash is requested every 60 ticks; the snapshot is built only at checkpoints and for joiners (`client/lockstep.ts:152`),
with compression on the TS side. The double `write` in `size` is the one wasteful item.

### 4-5. Entities and allocation
Per-tick allocations I found: `centres` (x2) in `refresh_active`, `core::mem::take(&mut self.queue)` (moves, does not allocate),
`stepping_set` and `alive_targets`, `crumble_islands` and `explosions` use `take`/restore (no allocation). Total a handful of small allocations per
tick; wasm's allocator is dlmalloc and a small alloc is about 50-100 ns. Not worth a diff on its own.

### 6. Boundary and client
Whole-grid copies per frame: none (the TS side views `mat_ptr` directly). Per frame the main costs are the two window `texSubImage2D` uploads
(about 0.13 MB) and `updateSurface` (finding 15). I did not read the rest of `worker.ts` in depth.

### 7. Build settings
`opt-level = 3`, `lto = true`, `panic = "abort"`; overflow checks and debug assertions are off by default in release. Missing: `codegen-units = 1`,
and no `wasm-opt` step in `build:sim` (checked `package.json` and the Dockerfile for `wasm-opt`: absent). Both are safe for determinism but change
`sim.wasm` bytes and so the sim build hash, which the server compares: ship them together with a deploy, not mid-room.

## Recommended order
1. Build settings plus `wasm-opt` (no code). Measure with `p1_bench` natively and the P1 Chromium harness at 4x for the wasm number.
2. `touch` division removal; snapshot size/write double build.
3. `update_cell` inert-first ordering, powder rng skip when one diagonal is open (bit-identical, verify with D1/D2/D3 and D7).
4. `moved` stamp, interior fast path, `updateSurface`: only if the 4x phone number stays over budget.

Every item marked "No" for result change still needs `pnpm test:determinism` and `pnpm check` before commit; the sleeping-invisibility test D7 is
the one most likely to catch a mistake in items 4-6.
