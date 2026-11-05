# rock-int re-merge report (5 Nov 2026)

Merged `multa` f3d4034 (D-191 band scan, docs, skills) into `rock-int` (falling rock v0.5, D-190, format 13). Merge commit f0808b1.

## Conflicts and resolution
- `docs/DECISIONS.md`: both rows kept, D-190 then D-191.
- `sim/tests/golden.rs`: kept branch's `golden-v13.bin` name; `SCRIPTED_HASH` re-recorded to 10930891175002194360.
- `sim/tests/fixtures/golden-v13.bin` (binary) and `perf-trace.txt`: re-recorded (PERF_REGEN / HF_REGEN).
- `sim/src/grid.rs` and `sim/tests/wake.rs` auto-merged (band scan and island/fall code live in different functions); no hand edits.

## Moved scenarios (perf-trace vs multa's trace; per-tick lines moved / total)
| scenario | per-tick | final snapshot line |
|---|---|---|
| sand_pour | 0/200 | moved (format 13) |
| water_flood | 0/200 | moved |
| lava_water | 0/200 | moved |
| fire_wood | 196/200 | moved |
| bomb | 0/200 | moved |
| mixed_sleep_on | 119/200 | moved |
| mixed_sleep_off | 119/200 | moved |
| survival_l | 0/150 | moved |
| creative_m_spells | 141/150 | moved |

fire_wood and creative_m_spells moved as expected (falling logs/islands). mixed_sleep_on/off also moved (identically 119 each, so sleeping stays invisible); the mixed scenario contains structural islands. No unexpected moves in the pure powder/liquid/bomb/survival scenarios.

## Gate (run-tests skill, chained with &&, background)
- cargo test --release: 42 binaries, 408 passed, 0 failed
- clippy wasm32 -D warnings: clean; typecheck clean
- determinism: 53/53 (11 files)
- net: 398 passed, 1 skipped (399), 57 files
- exit 0, merge commit f0808b1, pushed to origin/rock-int.

## Play server
http://localhost:8090 (sandbox at /sandbox), DATA_DIR /tmp/simulta-rock-play, log /tmp/simulta-rock-play.log. Built client; both sim.wasm sha256 cc1ca35ae624... match; `server.start` logged; agent-browser join turned the dot green.

## Browser look
- Hard-painted rock is unseeded (D-174), so a painted T on a pillar stays floating when the pillar is cut: expected, not a bug.
- A painted ~250-cell pillar cut at the middle crumbled to pebbles (over FALL_ISLAND_MAX 120): as designed.
- A small (~25 cell) rock column cut near its base: the upper part dropped as one piece and rested on the stub, intact. A hard-painted island is only detected when a neighbouring cell is removed by erase.
- Falling rock is best seen by erasing/digging under an island that was part of terrain; painted blocks fall only after erase touches them.

## Architectural decisions for review
None (merge; no new design choices).
