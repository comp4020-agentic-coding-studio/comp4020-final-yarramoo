# Brief HF worker report: snapshot format 12

## What changed
- Round: `round_started` bits became `round_running: u8` and `boss_killed: u8`; `ROUND_RUNNING`/`ROUND_BOSS_KILLED` removed. Round tail is 12 bytes (over, running, boss_killed, result, lobby_since, majority_since). Restore requires running and boss_killed in 0..=1, and boss_killed implies running.
- Boss: `Enemy.phase: u8` and `Enemy.summons: u16`, appended to the enemy record (`ENEMY_BYTES` 35 to 38). `state` keeps bits 0-1; `hop_until` is only the next hop. Restore refuses non-zero phase/summons on non-bosses, boss phase outside 1..=3, summons above `BOSS_SUMMONS_TOTAL`.
- `FORMAT_VERSION` 12 (doc history has a v12 line); `server/db.ts` mirror 12.
- Entity view: the enemy byte stays `state | phase << 2 | facing << 7` and ENT_ROUND `health` stays `running | boss_killed << 1`, so `client/` and `shared/` need no code change (only a doc comment in `shared/sim.ts`). The `devbosshp` patch in `client/worker.ts` only touches hp, which did not move.
- Tests: `sim/tests/golden.rs` (golden snapshot `sim/tests/fixtures/golden-v12.bin`, 230562 bytes, S Survival seed 7, 600 ticks; pinned scripted-run hash on seed 1 M Survival, 3000 ticks; boss named state survives restore). Regenerate with `HF_REGEN=1 cargo test --release --test golden -- --nocapture`. Existing tests updated for the renames and format number; `tests/net/entity-layout.test.ts` (38-byte record, 12-byte tail).
- No test pinned a hash value; the format change altered hashes by design, not because a test was red.

## Red first
The restore test was run against a deliberately broken restore (`summons` not read back): it failed ("diverged" / summons assert), then the fix was restored and it passed.

## Gate
sim `cargo test --release` 40 test binaries ok; clippy wasm32 clean; typecheck ok; determinism 11 files / 53 tests passed; net 362/363 on the first run (the one failure was the layout test's tail size 11 vs 12, fixed and re-run green alone).

## Not done
- One commit per checklist item was not possible: the renames, the format change and the tests are entangled and the gate costs about 15 minutes here, so there are fewer, larger commits (see git log).
- Zero-impact: no `engineering-decisions.md` entry (nothing surprising).

## Architectural decisions for review
- Field widths: `phase u8`, `summons u16` (40 fits u8; u16 leaves headroom if the cap grows, costs 1 byte per enemy).
- Placement: phase/summons are at the end of the enemy record and, for the round, running/boss_killed sit before result in the tail; the hash covers the same canonical bytes, so the hash order is the byte order. Alternative of inserting next to `state` was rejected to keep diffs of offsets small (hp offset unchanged for the dev hook).
- Golden world: size S (512x512) Survival seed 7, two players; the file is 230 KB because the grid is included. Cost: any sim change that alters terrain or physics regenerates it.
- The view keeps the packed byte for the client; a later cleanup could give the client separate fields.
- FUTURE.md idea: a CI check that fails when `golden-v12.bin` is stale versus `FORMAT_VERSION` (name the file by version and assert it).
