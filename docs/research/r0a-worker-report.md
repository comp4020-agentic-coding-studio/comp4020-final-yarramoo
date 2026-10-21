# R0a worker report (Sonnet): the room config in the sim

Baseline taken before any change (`sim/examples/r0a_baseline.rs`, kept in the working tree during the work, removed at the end):
`kind 0 seed 42` t0 47849b2915fd20d5, t40 4b1016db4c2ed5de, t80 b0c670377f5eb58f, t120 1ceb10edec9c88e2, chunkfold ac54c123fe8621ae;
`kind 1 seed 5` t0 ec5bc2ca643f77f9, t40 7ab15e7db3db0a8c, t80 1096472c1b8354e6, t120 f6cee6e1eaef5f9a, chunkfold 0d0989d17d40f9aa.
(These are the hashes the presets must reproduce, apart from the config bytes that commit 4 adds to the hash.)

## Commit 1: config.rs + shared/room.ts
- Red first: `sim/tests/config.rs` failed to compile (`could not find config in sim`); `tests/net/room.test.ts` failed (no `shared/room.ts`). Both written before the implementation.
- Green: both pass. Same vectors in both languages (3 good vectors, 17 single-byte mutations, wrong lengths).
- Gate: cargo test, both clippies, typecheck, test:determinism (40 pass), test:net (267 pass).
