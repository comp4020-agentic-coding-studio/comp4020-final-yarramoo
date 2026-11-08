# R0a worker report (Sonnet): the room config in the sim

Baseline taken before any change (`sim/examples/r0a_baseline.rs`, kept in the working tree during the work, removed at the end):
`kind 0 seed 42` t0 47849b2915fd20d5, t40 4b1016db4c2ed5de, t80 b0c670377f5eb58f, t120 1ceb10edec9c88e2, chunkfold ac54c123fe8621ae;
`kind 1 seed 5` t0 ec5bc2ca643f77f9, t40 7ab15e7db3db0a8c, t80 1096472c1b8354e6, t120 f6cee6e1eaef5f9a, chunkfold 0d0989d17d40f9aa.
(These are the hashes the presets must reproduce, apart from the config bytes that commit 4 adds to the hash.)

## Commit 1: config.rs + shared/room.ts
- Red first: `sim/tests/config.rs` failed to compile (`could not find config in sim`); `tests/net/room.test.ts` failed (no `shared/room.ts`). Both written before the implementation.
- Green: both pass. Same vectors in both languages (3 good vectors, 17 single-byte mutations, wrong lengths).
- Gate: cargo test, both clippies, typecheck, test:determinism (40 pass), test:net (267 pass).

## Commit 2: rule helpers
Sim::new(seed, impl IntoRoom); all 7 bare gates became helpers (`has_players`, `paint_allowed`). Old `Sim::new(seed, 0|1)` still compiles (tests, examples) via `IntoRoom for u8`. Baseline hashes for both worlds identical before/after (diffed).

## Commit 3: ABI
`init(seed_lo, seed_hi, cfg_ptr, cfg_len)`; length checked before the read. Red first: `tests/net/room-abi.test.ts` failed (3 of 4) against the kind-taking wasm, then passed. Compat test (deployed v1 wasm still has 3-arg init) needed a branch in `shared/sim.ts` keyed on `x.init.length`.

## Commit 4: snapshot format 4
Header 55 -> 70 bytes (config at offset 46..62). Hash = xxh3(tick, 16 config bytes, entity bytes, chunk hashes). Red first: `sim/tests/config_state.rs` 3/3 failed, then passed (hash differs per rule field, header carries config, every older format and every truncation refused, no panic).
Edited outside the strict file list because the format changed: `sim/tests/{bags,players,spells}.rs` (old-format and header-offset assertions), `server/world.ts` `ENTITY_AT` 55 -> 70, `tests/net/entity-layout.test.ts` HEADER, `tests/determinism/compat.test.ts` (v1 deployed snapshot is now refused; the old DATA/RULES pair is replaced by one refusal test; determinism test count 40 -> 39).

## Commit 5: protocol helpers by config; scripts accept config
`maxSnapshotRawFor`, `maxUploadFrameFor`, `chunkGridFor`, `chunkCountFor`, `maxChunkHashesFrameFor` take a `RoomConfig` and derive from size (chunks x 8194 B + 128 KiB, rounded up to MiB; upload = half the raw cap, at least 1 MiB). Same values as before for both presets, asserted in `tests/net/game.test.ts` (7 MiB, 4 MiB, 1 MiB, 1 MiB). Server (`World.cfg`) and client (`lockstep.ts`) map world 0/1 to presets locally; wire protocol unchanged. Scripts accept `"config"`; `world_kind` stays as alias. Red first for the script alias test (reverted `script.rs`, test panicked at the old `world_kind` read, then green). `MAX_UPLOAD_FRAME_GAME`/`MAX_SOCKET_PAYLOAD` constants are kept (the socket cap needs one number for all rooms).

## Commit 6: Docker
Built the real image, ran it as container `r0a-check` on port 8093, `APP_URL=http://localhost:8093 pnpm check` exit 0 (typecheck + 9 live tests), `/api/summary` shows worlds 0 and 1 ticking, no errors in the container log. Removed container and image by literal name. No fix needed, so no commit.

## Final state
Five commits on `multa`, none pushed. Gate (cargo test, both clippies, typecheck, test:determinism, test:net) green on each. Determinism: 41 tests in 11 files (was 40 in 10; compat.test.ts went 2 -> 1 test, script-config.test.ts added 2). net: 270 tests in 35 files (was 267 in 34). Baseline hashes for worlds 0 and 1 at ticks 0/40/80/120 and the chunk fold were identical before and after commit 2 (diffed). After commit 4 the state hashes change by design (config bytes now hashed); within-world behaviour is unchanged.

## Architectural decisions for review
1. **Config layout.** 16 bytes: version, 11 field bytes, 4 reserved zero. Every field is one byte, so `respawn_secs` and `max_players` fit; no field uses u16 (the brief said "u16 where noted", none was needed). Versioning: a version byte that must be 1; any other value is refused, no forward compatibility. Reserved bytes must be zero so a future field cannot be silently ignored by an old client. Cost later: adding a field means using a reserved byte (version stays 1 if old configs stay valid by being zero there) or bumping to 2 and refusing 1.
2. **Cross-field rule in decode:** `round == 1` requires `death == 1` (from the plan's "Needs death 1"). Both languages enforce it. Easy to relax later.
3. **Size S is 512x512, not the plan's 512x384.** Reproducing today's world 0 exactly was the hard requirement, so S stays 512x512 until R1 decides terrain sizes. `SIZES`/`SIZE_DIMS` is the one table to change. Flagged: changing it alters the snapshot and chunk grid.
4. **Terrain scope for R0a:** Caves only at size L, Empty box only at size S, Solid box refused (init returns -1). Reversible: R1 relaxes the checks in `Sim::new_with_base`. A config with Caves at size M therefore decodes fine but init refuses it.
5. **Rule helpers live in `sim/src/config.rs` on `RoomConfig`** (`has_players`, `damage_from_players`, `damage_from_env`, `paint_allowed`, `all_spells`, `dims`, `is_caves`). `damage_from_players`, `damage_from_env`, `all_spells`, `is_caves` and the fields `damage`, `spells`, `respawn_secs`, `pickup_respawn`, `death`, `round`, `max_players` are not yet read by gameplay code (only the hash and snapshot see them); the brief limited R0a to translating existing gates, so those rules are R2+ work. Only `has_players` (6 gates) and `paint_allowed` (1 gate) replaced bare checks. Note: the brief says 26 uses of world_kind; after reading, only 7 gates existed in `sim/src` (the rest were struct plumbing and tests).
6. **Mapping `world_kind == 0` meant "no avatars".** Every old `== 0` / `!= 0` gate was a has-players gate except the paint gate, which was "sandbox paints". Under the presets those coincide; the config makes them separate fields (`brushes` vs `avatars`), so a config with avatars on and brushes off paints nothing (matches Caves today, where Paint is ignored without the `dev_paint` feature).
7. **Hash coverage:** the full 16 config bytes go into the state hash right after the tick, before entity bytes. So `visibility` (server-only) is not in the config at all. Cost: every stored/fixture hash changed once, at commit 4.
8. **Snapshot format 4:** header 70 bytes (config at 46..62); refuses every other version, including v1-3 sandbox snapshots. This ended the deployed-sandbox compat guarantee (D-014); the game is not live, per the plan. `tests/determinism/compat.test.ts` now asserts the refusal. If the user does declare the sandbox live before R2, this needs a migration path. **Needs a DECISIONS.md row** (session model's call).
9. **`Sim::new(seed, impl IntoRoom)`**, with `IntoRoom` implemented for `RoomConfig`, `&RoomConfig` and `u8` (0 and 1 map to presets). Chosen so the ~50 existing Rust tests and examples (outside the file list) compile unchanged. More reversible than editing them all; the cost is a slightly odd generic and a u8 alias that should be dropped once tests move to presets.
10. **`shared/sim.ts` `init(seed, cfg: Uint8Array | number)`:** a bare number is the legacy kind and maps to a preset via `configForKind`, so ~25 test call sites keep working. Plus a branch keyed on `x.init.length === 3` to drive the old deployed wasm in the compat test. That branch is test-only baggage and can go if the compat test is dropped entirely.
11. **Protocol caps derived, not tabled:** snapshot cap = ceil((chunks x 8194 + 128 KiB) / MiB) MiB, upload = half. Asserted equal to the old constants for both presets. For size M this gives 1024x768 = 192 chunks -> 2 MiB raw, 1 MiB upload. Size L is the worst case and bounds `MAX_SOCKET_PAYLOAD`.
12. **Client caps** in `lockstep.ts` still infer the room from width x height (as before), now returning a preset. R2 replaces this with the config from WELCOME.

## Not done / caveats
- The "different configs, different hash at tick 0" test is in `sim/tests/config_state.rs` (Rust, red first). I did not add the TS twin in the ABI test after removing it from `room-abi.test.ts` (it needed the rebuilt wasm to be red; the Rust test is the evidence).
- `sim/tests/*.rs` still call `Sim::new(seed, 0|1)` through the alias; not migrated.
- Edits outside the brief's file list, all forced by the format change or API: `sim/tests/{bags,players,spells,determinism}.rs`, `server/world.ts` `ENTITY_AT`, `tests/net/{entity-layout,protocol,game,chunk-grid}.test.ts`, `tests/determinism/{compat.test.ts,run.ts}`, `server/main.ts` (one call), plus new `sim/tests/{config,config_state}.rs`, `tests/net/{room,room-abi}.test.ts`, `tests/determinism/script-config.test.ts`.
- `docs/engineering-decisions.md` and `docs/DECISIONS.md` rows left for the session model (items 3, 8, 9 are the candidates).
