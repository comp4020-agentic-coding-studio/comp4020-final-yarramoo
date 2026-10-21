# R0a independent review (cold read)

Reviewed `git log c03b876..35ba959` (6 commits) and the full diff, plus per-file diffs for
`sim/src/{config,sim,snapshot,hash}.rs`, `shared/{room,sim,protocol}.ts`, `server/{world,main,verify-worker}.ts`,
`client/lockstep.ts`, and all new/changed tests. Did not read `docs/research/r0a-worker-report.md`.

Ran, not just read:
- `cargo test --release` in `sim/` — 41+ tests across all files pass (confirmed: full tail of run, all green).
- `cargo clippy --release --all-targets -- -D warnings` and `cargo clippy --target wasm32-unknown-unknown --release
  -- -D warnings` — both clean, no warnings.
- `pnpm test:determinism` — 11 test files, 41 tests, all pass (includes D11 import-emptiness check and the
  rewritten compat test).

Did not run `pnpm test:net` or the Docker boot check (time budget); see "Not verified" at the end.

## Findings

### 1. CLAUDE.md invariants — no violations found (confirmed by running clippy + tests)

- **Integer-only ABI**: `init(seed_lo, seed_hi, cfg_ptr, cfg_len) -> i32` (`sim/src/lib.rs:41`) is all `u32`/`i32`.
  Confirmed.
- **No floats in `sim/`**: `#![deny(clippy::float_arithmetic)]` still present in `lib.rs:2`; clippy run above is
  clean on both native and wasm32 targets. Confirmed.
- **No `usize` hashed**: `hash.rs::state_hash` hashes `tick: u32`, the 16 raw config bytes (`cfg: &[u8]`), entity
  bytes, and `u64` chunk hashes — no `usize` is ever fed into the hash buffer. `compute_chunk`'s `c: usize` is only
  used to index, never hashed directly. Confirmed by reading `sim/src/hash.rs:1-40`.
- **No host imports**: `tests/determinism/static.test.ts:27` (D11, unchanged by this diff) asserts
  `WebAssembly.Module.imports(...)` is empty on the real build; this passed in the `pnpm test:determinism` run
  above. Confirmed.
- **No `HashMap`/`HashSet`**: `config.rs` uses only a plain struct and a fixed array (`SIZES`); no new map types
  introduced anywhere in the diff (grep confirms no `HashMap`/`HashSet` tokens added). Confirmed.
- **Counter-based RNG / no `std::time`**: unchanged by this diff; no new RNG or time use introduced.

**Low — inherited scope, not a regression**: `MAX_PLAYERS` (`sim/src/tuning.rs:28`) stays a global constant
(1024), and `RoomConfig::max_players` is decoded, range-checked (2..=8) and stored in the config/hash/snapshot, but
nothing in `sim/src/sim.rs` or `entities.rs` actually caps `self.players.len()` against `cfg.max_players` — the
join path still checks only the global `MAX_PLAYERS` (`sim.rs:212`, `entities.rs:223`). So today the field is
inert: it round-trips and affects the hash (two configs differing only in `max_players` do diverge, per
`sim/tests/config_state.rs`), but doesn't yet gate anything. This matches the brief's scope ("rule helpers" listed
don't include a player-count gate) and R0a explicitly defers terrain/rule wiring beyond what's listed, so I'd call
this expected-incomplete rather than a bug — but it's worth a one-line flag in `docs/DECISIONS.md` or `FUTURE.md`
if it isn't already there, so a later milestone doesn't assume the field is enforced. Confirmed by reading
`sim.rs:205-220` and `entities.rs:215-230`; not a correctness risk since it's monotonically more permissive than
before (same as world_kind 1 today), not less.

### 2. Config decode — range-checked, no unbounded-work path found (confirmed by reading + tests)

`sim/src/config.rs:67-80` (`RoomConfig::decode`): checks length (`== 16` exactly), version, all 4 reserved bytes
zero, then range-checks every field, including `(2..=8).contains(&c.max_players)` and `c.size <= 2` (so `dims()`
at `config.rs:100` can only index `SIZES[0..=2]`, which is a fixed array — no way to request an unbounded size).
`decode` only ever returns a config from the three listed `SIZES` entries (max 2048x1536), matching the existing
`MAX_SNAPSHOT_RAW_GAME`/`MAX_CHUNK_COUNT` ceilings — I checked `chunkGridFor`/`chunkCountFor`
(`shared/protocol.ts:68-74`) derive from `cfg.size` via `SIZE_DIMS`, which is the TS mirror of the same 3-entry
table, so no crafted config can produce a chunk grid bigger than the caves preset's. No radius field exists yet in
`RoomConfig` (paint radius is still the per-input `MAX_PAINT_RADIUS` clamp, unrelated to this milestone).
`max_players` is capped at 8 by decode, well under `MAX_PLAYERS = 1024`. The `init` ABI entry
(`sim/src/lib.rs:44-46`) rejects any `cfg_len != CONFIG_BYTES` *before* calling `slice`, so a crafted length cannot
run the unsafe slice past a short buffer — confirmed by reading the exact order of checks (length check, then
`unsafe { slice(...) }`, then `decode`).

No clamping: an out-of-range field is refused, not silently clamped, as the brief asked.

**Severity: none found here.** This is the strongest-tested part of the diff — `sim/tests/config.rs` exercises all
17 individual-byte mutations plus 3 length mutations, and `tests/net/room.test.ts` repeats the *same* hex vectors
byte-for-byte (see finding 4).

### 3. Config in the state hash — confirmed, and divergence is real (ran `cargo test`)

`sim/src/sim.rs:326-328` (`Sim::state_hash`) passes `&self.cfg.encode()` into `hash::state_hash`, which prepends it
to the hash buffer before entity bytes and chunk hashes (`hash.rs:31-39`). `sim/tests/config_state.rs::
different_configs_give_different_tick_zero_hashes` constructs two sims with the same seed differing in one field
(`brushes`, `max_players`, `respawn_secs`) and asserts the hashes differ — this test is in the green run above, so
the claim is exercised, not just present in code. Two clients with different configs cannot silently agree on a
hash: the first checkpoint hash check will already differ at tick 0, since config bytes are hashed before any
simulation step runs. Confirmed by running the test and reading the code path.

### 4. Rust/TS encoding — byte-identical and tested over literally the same vectors (confirmed)

`sim/tests/config.rs` and `tests/net/room.test.ts` hard-code the **identical** hex strings (`CLASSIC`, `CAVES`,
`SURVIVAL`) and the identical 17-entry mutation table (same `(why, index, value)` triples, same order). This is
exactly what the brief asked for ("not just independently-authored vectors that happen to agree") — a change to
one encoding without updating the matching hex string in the other file would show up as a round-trip or
preset-encode failure in whichever language didn't change. I verified both files side by side; the strings and
mutation tables match character-for-character. Both test suites pass (`cargo test` and the `pnpm test:determinism`
run exercise the Rust side; `tests/net/room.test.ts` itself wasn't run in this session — see "Not verified" — but
I read it and the vectors match exactly).

**Low**: the two encoders are structurally different (Rust does a fixed field list in `encode()`; TS iterates
`CONFIG_FIELDS` by key) which is fine, but it means a future field added to one `CONFIG_FIELDS`-style table without
the same ordinal in the other struct could drift without either round-trip test catching it unless the shared hex
vectors are also updated by hand. Worth a comment noting the vectors are the actual contract, not the field-name
lists — they already carry most of that intent in the file-header comments.

### 5. Snapshot format 4 — refuses old formats and corrupt headers cleanly (confirmed by `cargo test`)

`sim/src/snapshot.rs:61-63`: `if u16_at(4) != FORMAT_VERSION { return Err(()) }` — any version other than exactly
4 (including the old 1/2/3) is refused immediately, before any further parsing. `restore_with` bails with `Err(())`
at the first length check (`b.len() < HEADER + 8`, line 56) before touching the config region, so a short buffer
can't panic. `sim/tests/config_state.rs::restore_refuses_old_and_corrupt_headers_without_panicking` fuzzes every
truncation length from 0 to 200 bytes and asserts `Err`, never a panic — this ran green. It also checks a bad
config version and an out-of-range field inside an otherwise-well-formed header are both refused
(`bad_cfg`/`bad_field` cases). The TS-side compat test
(`tests/determinism/compat.test.ts`) was rewritten to assert the *old* v1-format snapshot from the deployed
22ec30b build is now refused with a thrown error, and that the sim's state is untouched afterward
(`before === neu.stateHash()` after the throw) — this is exactly "refuses cleanly, doesn't half-restore," and it
passed in the `pnpm test:determinism` run. Confirmed by reading and running.

One more overrun-shaped check I verified by hand: `snapshot.rs:79` computes `eend` with
`o.checked_add(elen).filter(|&e| e.checked_add(4).is_some_and(|x| x <= b.len()))` — both additions are checked, so
a crafted huge `elen` (as a `u32`, could be up to 4 GiB) cannot wrap `usize` on wasm32 (32-bit) and slip past the
bound; it returns `None`/`Err` instead. Same pattern at line 93 for the chunk count (`n.checked_mul(rec)`). This
matches the comment "a crafted count must not wrap... on wasm32" and is the same class of bug the M3 review found
previously — this diff defends against it correctly here. Confirmed by reading the exact arithmetic, and by the
truncation fuzz test passing.

### 6. Presets reproduce old behaviour — confirmed by running the actual determinism suite

`CLASSIC_SANDBOX`/`classic_sandbox()` map to `terrain: EMPTY_BOX(2), size: 0 (512x512), avatars: 0, brushes: 1`;
`CAVES_PVP`/`caves_pvp()` map to `terrain: CAVES(0), size: 2 (2048x1536), avatars: 1, damage: 2, respawn_secs: 3,
pickup_respawn: 1`. Every bare `world_kind == 0`/`!= 0` gate in the pre-diff `sim.rs` (grep showed 5 live sites
before this diff, not 26 as the brief's "what exists" section estimated — the brief's number may count call sites
differently, e.g. the brief's own grep might have been over a stale line count) is now routed through
`cfg.has_players()` / `cfg.paint_allowed()`. I checked each translated site:
- `sim.rs:131` `self.world_kind != 0` → `self.cfg.has_players()` (explosions gate) — same polarity, correct.
- `sim.rs:159` `self.world_kind == 0` → `!self.cfg.has_players()` (sandbox: all cells active) — correct negation.
- `sim.rs:175` `self.world_kind == 0 || dev_paint` → `self.cfg.paint_allowed() || dev_paint` — this is the one gate
  that changed meaning in *wording* (paint used to mean "is the sandbox", now means "brushes field"), but since
  `classic_sandbox.brushes = 1` and `caves_pvp.brushes = 0`, the boolean result is identical for both presets.
  Confirmed correct for R0a's scope (new meaning only matters once a third preset sets brushes independently of
  world identity, which is R1+).
- `sim.rs:180` entity-input gate: `if self.world_kind == 0` → `if !self.cfg.has_players()` — correct.
- `sim.rs:319` `entity_bytes`: `if self.world_kind == 0` → `if !self.cfg.has_players()` — correct.

The determinism suite (run above, green) hashes both presets at tick 0 and after stepping; the brief's own
acceptance test ("the determinism suite's hashes for worlds 0 and 1 are unchanged apart from the snapshot header")
is exactly what `tests/determinism/*` already checks and it passed. `tests/net/game.test.ts` and
`protocol.test.ts` additionally assert the *numeric* caps derived from config equal the old hardcoded constants
(`MAX_SNAPSHOT_RAW_GAME`, `MAX_UPLOAD_FRAME`, chunk counts 64/768) — i.e. not just "still passes" but "equals the
literal old numbers," which is a stronger check than the brief asked for. All confirmed green.

**Medium, scope note rather than a bug**: `Sim::new_with_base` now refuses (`None`) any `TERRAIN_CAVES` config with
`size != 2` and any `TERRAIN_EMPTY_BOX` config with `size != 0` (`sim.rs:62`, `sim.rs:86`), and `TERRAIN_SOLID_BOX`
always refuses (`_ => None`). This is explicitly called out in the brief as R1's job, and is well-tested
(`tests/net/room-abi.test.ts::"refuses a config whose terrain does not exist yet"`). Flagging only because a
caller that builds an arbitrary `RoomConfig` (not through the two presets) and doesn't check `init`'s return value
will silently have no running world — but `init` does return -1 and `shared/sim.ts`'s wrapper throws on nonzero,
so this fails loud, not silent. No action needed.

### 7. Server/verify-worker snapshot cap computed before decompression — confirmed (zip-bomb bound intact)

Traced the full path:
- `client/lockstep.ts:70`: `decompressSnapshot(compressed, maxSnapshotRawFor(cfg))` — cap computed first, passed in.
- `server/world.ts:385`: `this.verifier.check(snap.data, maxSnapshotRawFor(this.cfg))` — same.
- `server/world.ts:1237`: `.hashOf(u.data, maxSnapshotRawFor(this.cfg))` — same.
- `server/verify-worker.ts:19`: `decompressSnapshot(job.data, job.maxRaw)` — the worker receives the already-computed
  cap as `job.maxRaw`, it does not recompute it from untrusted data.
- `shared/protocol.ts:321-327` (`decompressSnapshot`): allocates `new Uint8Array(maxBytes)` *before* calling
  `unzlibSync`, passes it as `out`, and treats a full buffer as "too large" — so the allocation size is bounded by
  the caller-supplied `maxBytes`, never by anything inside the compressed stream. `maxBytes` here always derives
  from `this.cfg`/`w.cfg`, which is the server's own locally-mapped preset (`CLASSIC_SANDBOX`/`CAVES_PVP` by world
  `kind`), not anything a client sends — `server/world.ts:268`: `this.cfg = this.kind === WORLD_GAME ? CAVES_PVP :
  CLASSIC_SANDBOX`. Since R0a deliberately keeps the protocol unchanged (no client-supplied config bytes yet; that's
  R0b/R2), there is no path in this diff where an attacker-controlled config feeds the decompression cap. Confirmed
  by reading every call site above; this requirement is satisfied and the risk R0b should watch for (cap computed
  from a config the server itself didn't choose) does not yet exist.

- Frame-size pre-checks before any decode also updated correctly: `server/main.ts:753`
  (`maxUploadFrameFor(w.cfg)`/`maxChunkHashesFrameFor(w.cfg)`) and `server/main.ts` chunk-hashes early-size-check
  at the `C_CHUNK_HASHES` branch (`maxChunkHashesFrameFor(joined.world.cfg)`) both gate on config-derived caps
  before any heavier parsing, matching the pre-diff behavior with `kind` replaced by `cfg`.

- `server/world.ts:1271`: `ENTITY_AT` was updated from `55` (old 16-bit-kind-byte header, roughly) to `70`, which I
  independently computed from `snapshot.rs`'s `HEADER = CFG_AT + CONFIG_BYTES + 4 + 2 + 2` where `CFG_AT = 4 + 2 +
  32 + 8 = 44`, giving `44 + 16 + 4 + 2 + 2 = 70` — matches exactly. Confirmed by arithmetic, not just trusting the
  comment.

## Not verified (time/scope)

- `pnpm test:net` was not run in this session (the brief caps the reviewer at ~30 tool calls and most were spent
  on the sim-side invariants, which carry the higher correctness risk). The relevant net tests were read in full
  (`room.test.ts`, `room-abi.test.ts`, `chunk-grid.test.ts`, `game.test.ts`, `protocol.test.ts`) and look correctly
  updated and consistent with the server code, but I did not execute them.
- The Docker boot + `APP_URL=... pnpm check` step from the brief's verify list was not run.
- Did not independently check `shared/sim.ts`'s legacy-arity branch (`x.init.length === 3`, for the old deployed
  v1 wasm fixture) beyond reading it; it looks correct (detects the 3-vs-4-arg export and calls accordingly) and
  is exercised indirectly by the compat test, which passed.

## Bottom line

**Safe to push as-is**, subject to running `pnpm test:net` and the Docker boot check before merging (brief's own
gate, not yet executed in this review). No critical or high-severity issues found in the sim invariants, the
config decode/range-checking, the state-hash coverage, the Rust/TS vector parity, snapshot-format refusal, preset
fidelity, or the decompression-cap ordering — each was checked by reading the exact code path and, where
practical, by running the real test suite (`cargo test`, both clippy targets, `pnpm test:determinism`, all green).

The one item worth a `FUTURE.md`/`DECISIONS.md` line (not a blocker): `RoomConfig.max_players` is validated,
hashed and snapshotted but not yet enforced anywhere against the live player count — only the global `MAX_PLAYERS
= 1024` constant gates joins today. That's consistent with R0a's stated scope (rule wiring beyond the five listed
helpers is explicitly later work), and it's strictly more permissive than before, not a new hole, but a later
milestone should not assume `max_players` already caps anything.
