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
