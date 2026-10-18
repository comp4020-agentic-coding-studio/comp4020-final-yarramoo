# M3 review (origin/multa..HEAD), read-only

## Verdict: no blockers. Sleeping, generation, restore and the client camera trace as sound. Should-fixes are about M4 readiness.

## CONFIRMED (code path traced)

### S1 should-fix: snapshot size ceilings are sandbox-sized (shared/protocol.ts:26-29, server/world.ts:21)
MAX_SNAPSHOT_RAW = MAX_UPLOAD_FRAME = 1 MiB. A game-world snapshot is 2 + 8192 bytes per non-pristine chunk, up to 768 chunks, about 6.3 MB raw.
Scenario: when M4 flips WORLD_KIND to 1, `decompressSnapshot` throws "snapshot too large" and every upload is rejected. The world never gets a snapshot and the log grows without bound.
Fix: size the caps from world kind, and check compressed size against the 1 MiB frame cap with a real world.

### S2 should-fix: restore regenerates the world; it happens twice on the client and once per upload on the server
- sim/src/snapshot.rs:58 calls `Sim::new`, which runs gen (about 400 ms).
- client/worker.ts:160 calls `init`, which generates, and then `lockstep.restore` generates again. A join or resync costs about 800 ms of worker time.
- server/verify.ts:hashOf restores on the server's main thread every snapshot upload (every 1800 ticks). That is about 400 ms of event-loop block per upload, against a 16 ms tick clock.
Fix: cache the generated base `mat` (3 MB) in a static keyed by (seed, kind) and memcpy it in `Sim::new` and `restore`. Alternatively skip `init` when a snapshot will follow. On the server, restore in a worker thread, or ship non-pristine-only state for the verifier.

### S3 should-fix (M4 trap): snapshot::size ignores entity bytes (sim/src/snapshot.rs:40 vs :20-22)
`write` appends `e` and always writes entity count 0. `size` is `HEADER + 4 + 4 + live*rec`, with no `e.len()`.
Scenario: once `entity_bytes()` is non-empty, `snapshot_write` overruns the buffer allocated from `snapshot_size`. This is memory corruption in wasm. `restore` also rejects any non-zero entity count.
Fix: include `e.len()` in `size` and write the real count now, plus a test that `size == write.len()` with a non-empty entity blob.

### S4 should-fix: restore parsing can wrap or panic on hostile input (sim/src/snapshot.rs:67-70)
`n as usize * rec` overflows on wasm32 (32-bit usize; release has no overflow checks). A crafted `n` can pass `b.len() == o + n*rec`, and the later slicing then panics. `panic=abort` traps. The server's try/catch contains it, but the trap leaves the wasm instance in an unknown state.
Fix: `n.checked_mul(rec)` in u64, and `n <= chunk_count`.

### S5 note: MAX_CHUNKS is a stale, unchecked contract (shared/sim.ts:44)
The comment says "32x32 chunks is 3072". CHUNK is 64, so the game world has 768 chunks. `chunk_hashes` writes `chunk_count*8` bytes into a buffer of MAX_CHUNKS*8; nothing asserts chunk_count <= MAX_CHUNKS. Fix the comment, and either export `chunk_count()` from the ABI and size the buffer from it, or add a Rust test that the largest world fits.

### S6 note: other Rust/TS numbers that nothing ties together
- Rust GAME_W/H, TS SANDBOX=512, GAME_VIEW 480x270, and the camera spawn row `230` (hard-coded in client/main.ts, equal to gen.rs SURFACE_Y).
- `Grid::new` silently truncates `w / CHUNK`. Add `assert!(w % CHUNK == 0 && h % CHUNK == 0)`.
- sim.rs WALL_COLS duplicates gen.rs WALL_COLS.
- ACTIVE_W/H (576x320) versus the client view of 480x270 are only related in a comment.

### S7 note: refresh_active fallback (sim/src/sim.rs:85-92)
The active set is derived from nothing today (all-active). It is a pure function of Sim state (world_kind plus the centres list), so a restored client agrees. M4 only has to fill `centres` from entity state that is in the snapshot or hash. No restructure is needed. Two M4 cautions:
- "No players => all active" means an empty world runs at worst-case cost, and the active set flips between all and frozen as the first player joins or the last leaves. Catch-up replay of an empty stretch is all-active. D-053 plans to delete the fallback; delete it.
- Cells can swap into an inactive chunk, then freeze mid-air there. This is deterministic, just a physics oddity at the margin.

### S8 note: dev_paint cannot ship (Dockerfile:12, package.json:11-15, client/vite.config.ts)
- The Dockerfile builds without features; `build:client` copies only sim.wasm; `sim-dev.wasm` is served by the dev middleware only.
- Residual: the production client bundle still honours `?world=game` and requests `sim-dev.wasm`, which gives a 404 and a broken page, not a desync. Gate `localKind` on `import.meta.env.DEV`.
- `cargo test --all-features` would turn on both canary (a host import) and dev_paint.

### S9 note: per-tick `moved.fill(0)` clears 3.1 MB (grid.rs:152) even when 80 of 768 chunks run. Clear only the run chunks' rows if step time at rest matters.

## SOUND (traced)
- **Invariant 8 (sleeping):** every cell write goes through `set` or `swap`, both of which `touch`. The `touch` wake covers distance 1 including corners. All non-volatile materials read at most 1 cell (sand, water, powders, gunpowder reading fire or lava). Everything that reads further or acts on chance, a timer or a counter is volatile and keeps its chunk awake: Seed (2-cell wet check), Fire, Smoke, Steam, Lava, a growing Stem tip, primed Gunpowder.
  - Cross-edge moves: a swap touches both cells' chunks. A neighbour that already ran this tick gets awake=true for next tick; one that has not run yet runs this tick.
  - Explosions: carving goes through `set`; leftovers beyond the cap stay primed, so they stay volatile.
  - Lava's every-other-tick move: lava is volatile, so its chunk never sleeps.
  - The `moved` skip sets `vol_seen`, which is conservative.
- **Restore versus a never-restored client:** `awake`, `active`, `moved`, `pending`, `spots` and `ran_chunks` are scratch or derived. `restore` starts with every chunk awake, which is a superset of the real state, so correctness rests only on invariant 8. `pristine` and `dirty` differ in no way that affects hashes or later steps.
- **No usize in hashed or snapshotted bytes:** chunk indices go out as u16, counts as u32, w/h as u16. rng args are cast to u32.
- **Generation:** integer-only, with a checked-in smoothstep table; no recursion; every loop is bounded (worm steps <= 2500, 5 branches each, `wander_link` steps bounded by 4*dist+100, iterative flood, pool flood capped). Signed shifts and divisions are well defined. Chunks stay pristine, so restore-from-regenerate is correct.
- **Client:** no write to sim memory (views are read-only, local paint goes through `pushInput`). The camera is client-only and never an input. The windowed upload covers the shader's sampling window (2-cell margin).

## D7 coverage gaps (SUSPECTED, not bugs)
- `set_active_around` is dead code with no test. Add a D7 variant with a fixed centre list, sleep on versus off.
- No D7 or restore-mid-run test with sleeping on in the sandbox. The game-world restore test in tests/determinism/gen.test.ts covers one seed at tick 300.
- The 1-cell read radius is an unwritten rule. Add a comment on `update_cell`, or a test, that any new material reading at distance >= 2 must be volatile.
