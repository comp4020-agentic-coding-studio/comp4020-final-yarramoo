# F4 worker report: enemies slice 1 (Slime) plus one-life co-op Survival

## Commits

### 1. Config byte 12 `enemies` and the SURVIVAL preset
- Changed: `sim/src/config.rs` (`enemies`, `survival()`, `has_enemies()`, reserved now bytes 13..16),
  `shared/room.ts` (`CONFIG_FIELDS`, `SURVIVAL`), `client/menu.ts` (Survival card uses `SURVIVAL`, co-op text,
  `pvp: false`), `sim/src/script.rs` and `tests/determinism/run.ts` (script preset name `survival`), vectors in
  `sim/tests/config.rs` and `tests/net/room.test.ts`, `sim/tests/config_state.rs` (enemies is in the hash).
- Red first: with the Rust/TS sources stashed, the test files failed to compile (Rust) and 2 vitest cases failed
  (`presets encode to the shared vectors`, `good vectors round-trip`). Green after.
- Gate: cargo test, clippy, typecheck, test:determinism all green.

