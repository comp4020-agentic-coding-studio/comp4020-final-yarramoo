# Brief R0a: the room config in the sim

Written 21 Oct night by the session model, ready to dispatch after the budget reset. Milestone R0 of
`docs/plan-game-modes.md`, split in two. R0a (this brief) puts the config in the sim with worlds 0 and 1 as
presets, and **doesn't change the protocol**. R0b (carrying the config in WELCOME and HELLO) folds into R2, which
changes the protocol anyway.

**Dispatch:** one Sonnet worker, medium effort, about 80 tool calls. Then one independent Sonnet reviewer
(medium, about 30 calls) reads the diff cold and writes `docs/research/review-r0a.md`. The session model checks
each finding against the code before acting on it.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. A multiplayer falling-sand game in
deterministic lockstep: a Rust WASM sim in `sim/` runs identically on every client; the Node server relays inputs.
Read `CLAUDE.md` first (the sim invariants are binding: integer-only ABI, no floats, no HashMap, hash fixed-width
ints only, no host imports). Then read `docs/plan-game-modes.md`, sections "The idea: a room is a seed plus a
config" and "Config fields". **The game is not live**, so snapshot format breaks are fine, and old formats can be
refused. Rust needs `PATH="$HOME/.cargo/bin:$PATH"`. Every `rm` names an explicit literal absolute path. Never use
port 8080.

## What exists

- **Sim entry:** `init(seed_lo, seed_hi, world_kind)` in `sim/src/lib.rs:40`, then `Sim::new(seed, world_kind)` in
  `sim/src/sim.rs:51`.
- **Sizes:** chosen by kind in `sim.rs:57`: 0 is 512x512, 1 is 2048x1536.
- **Rule gates:** `world_kind` is checked bare at `sim.rs:122, 150, 166, 171, 310`; 26 uses in all (grep).
- **Snapshot:** `FORMAT_VERSION = 3` (`sim/src/snapshot.rs:10`), header holds `world_kind` (`snapshot.rs:19`). The
  base cache matches on seed and kind (`lib.rs:133`, `sim.rs:63`).
- **TS side:** `shared/sim.ts:5,96,193` wraps `init`. Callers are `client/worker.ts:267,779`,
  `server/verify-worker.ts` and `tests/determinism/helpers.ts`. `shared/protocol.ts:58-70` has `WORLD_SANDBOX`,
  `WORLD_GAME` and three ternary helpers (`maxSnapshotRawFor`, `maxUploadFrameFor`, `chunkGridFor`).
- **Scripts:** `sim/src/script.rs:94` reads `world_kind` from determinism scripts.

## What to build

1. **`sim/src/config.rs`:** `struct RoomConfig` with the plan's fields as `u8` (and `u16` where noted), all
   integers: `terrain, size, avatars, damage, spells, brushes, death, respawn_secs, pickup_respawn, round,
   max_players`. Visibility is server-only, so it's not in the sim.
   - `fn decode(&[u8]) -> Option<RoomConfig>`: fixed 16-byte layout, a version byte first (1), reserved bytes must
     be zero, every field range-checked.
   - `fn encode(&self) -> [u8; 16]`.
   - Rule helpers: `has_players()`, `damage_from_players()`, `damage_from_env()`, `paint_allowed()`,
     `all_spells()`, `dims() -> (usize, usize)`.
   - Two presets, `RoomConfig::classic_sandbox()` (today's world 0) and `RoomConfig::caves_pvp()` (today's world
     1), which **must reproduce today's behaviour exactly**.
2. **ABI:** `init(seed_lo, seed_hi, cfg_ptr, cfg_len) -> i32` (the config bytes are written with `alloc` first,
   the way inputs are). Returns -1 on a bad config. Integers only.
3. **`Sim::new(seed, &RoomConfig)`:** replace every bare `world_kind` check with a rule helper. Size comes from
   `dims()`. Terrain: Caves uses `gen::generate` (R1 makes it walkable). For R0a, Solid box and Empty box may
   return `None` (refused) unless trivial; they're R1's job. Keep the `dev_paint` feature behaviour.
4. **Snapshot format 4:** the header stores the 16 config bytes instead of the kind byte. Restore refuses formats
   below 4. The state hash covers the config bytes, so two clients with different configs diverge at the first
   hash. The base cache matches on seed plus config bytes.
5. **TS:** `shared/room.ts` is the config table: field names, ranges, `encodeConfig`/`decodeConfig`
   byte-identical with Rust, and presets `CLASSIC_SANDBOX` and `CAVES_PVP`. `shared/sim.ts` `init(seed, cfg:
   Uint8Array)`. `shared/protocol.ts` helpers take a config (snapshot cap and chunk grid from size and terrain)
   instead of a kind. Server and client map world 0 to `CLASSIC_SANDBOX` and world 1 to `CAVES_PVP` **locally**,
   so the protocol is unchanged.
6. **Determinism scripts:** `script.rs` accepts `"config": "classic_sandbox" | "caves_pvp"` (keep accepting
   `world_kind` 0 and 1 as aliases so existing scripts run unchanged).

## Verify

- **A config round-trip test in both languages over the same byte vectors**: the TS test reads a JSON fixture
  that a Rust test writes, or the same table hard-coded in both. Show it red first (write it before `config.rs`).
- **Bad configs refused:** out-of-range field, wrong version, non-zero reserved byte. `init` returns -1.
- **Presets reproduce today:** the determinism suite's hashes for worlds 0 and 1 are **unchanged** apart from the
  snapshot header. If a world hash changes, find out why before touching any fixture; R0a must not change
  simulation behaviour.
- **Different configs, different hash:** two sims, same seed, configs differing in one rule field, give different
  state hashes at tick 0.
- **Gate every commit on exit codes:**
  `(cd sim && cargo test --release && cargo clippy --release --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown --release -- -D warnings) && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...`
- `sim.wasm` imports nothing (CI and the D-suite check it).
- **Boot the real Docker image** and run `APP_URL=http://localhost:8093 pnpm check`. Both worlds must work. Then
  `docker rm -f` the container by its literal name.

## Files you may touch

`sim/src/{config.rs (new), lib.rs, sim.rs, snapshot.rs, script.rs, spells.rs, entities.rs}` (only where a
`world_kind` gate sits), `shared/{room.ts (new), sim.ts, protocol.ts}`, `server/{world.ts, main.ts,
verify-worker.ts, verify.ts}` (kind-to-config mapping only), `client/{worker.ts, main.ts, lockstep.ts}`
(kind-to-config mapping only), `tests/determinism/*` (helpers and new tests), `tests/net/*` (new tests only).

## Commits (checklist; each gated)

1. [ ] `config.rs` and `shared/room.ts` with the round-trip and refusal tests (red first)
2. [ ] Sim rule helpers replace bare `world_kind` checks (behaviour unchanged; determinism hashes unchanged)
3. [ ] The ABI takes config bytes; `shared/sim.ts` and all callers updated
4. [ ] Snapshot format 4 with config in header and hash
5. [ ] `protocol.ts` helpers by config; scripts accept `config`
6. [ ] Docker boot plus `pnpm check` (no commit unless a fix is needed)

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews and pushes.

## Report

What changed, per commit; the red-then-green evidence; the determinism results; the Docker check. Include a
section **"Architectural decisions for review"**: the config layout and versioning, where rule helpers live, the
hash coverage, and anything you were unsure about that is hard to reverse, where you should take the more
reversible option and flag it. Also FUTURE.md ideas.

---

## Brief for the independent reviewer (after the worker reports)

Read the R0a commits cold (`git log` and the diffs). Don't read the worker's report. Check, and write findings to
`docs/research/review-r0a.md`:

- **Invariants 1-11** of `CLAUDE.md`, especially integer-only ABI, no floats, no usize in hashes, no host imports.
- **Config decode:** is every field range-checked? Can a crafted config cause unbounded work (e.g. a size beyond
  the snapshot cap, a radius, `max_players` beyond `MAX_PLAYERS`)?
- **Is the config in the state hash?** Could two clients with different configs agree on a hash?
- **Rust and TS encodings byte-identical?** Is that tested over the same vectors?
- **Snapshot format 4:** does restore refuse old formats cleanly, without panicking? Are header lengths validated
  before slicing (the M3 review found a buffer overrun here)?
- **Do presets reproduce the old behaviour exactly?** Look for a gate that was translated wrongly (e.g. `== 0`
  became `!has_players()` where the old code meant something else).
- **Server and verify worker:** is the snapshot cap computed from the config before decompressing (zip-bomb
  bound)?

Label each finding: severity, file:line, a concrete failure scenario, and whether you confirmed it by running
something.
