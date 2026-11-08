# D-217: the duplicated rng salts renumbered (branch `salts`)

Item 5 of `docs/briefs/backlog-2026-11-08.md`. Lead: Opus, no workers. Cap $8. Commits: `e81c715` (renumber + test, gated).

## What changed

`sim/src/rng.rs`: the eight spells' cell-rule salts move from 260-267 (where they shared values with the biome
generation salts) to 291-298, the next unused block after `SALT_GEN_WELL_DIM = 290`. The generation salts are
untouched, so generated worlds are identical.

| Salt | Old | New | Shared with (old) | Used at |
|---|---|---|---|---|
| `SALT_MUD_MOVE` | 260 | 291 | `SALT_GEN_BIOME` | `grid.rs` `update_mud` |
| `SALT_SALT_DIAG` | 261 | 292 | `SALT_GEN_BIOME_R` | `grid.rs` `update_salt` |
| `SALT_SALT_MELT` | 262 | 293 | `SALT_GEN_LAKE_X` | `grid.rs` `update_salt` |
| `SALT_SNOW_DIAG` | 263 | 294 | `SALT_GEN_LEDGE` | `grid.rs` `update_snow` |
| `SALT_SNOW_PACK` | 264 | 295 | `SALT_GEN_ICE_POOL_X` | `grid.rs` `update_snow` |
| `SALT_THERMITE_DIAG` | 265 | 296 | `SALT_GEN_ICICLE` | `grid.rs` `update_thermite` |
| `SALT_THERMITE_EAT` | 266 | 297 | `SALT_GEN_MOSS` | `grid.rs` `update_thermite` |
| `SALT_QUAKE` | 267 | 298 | `SALT_GEN_MUSH` | `spells.rs` `quake_cast` |

`sim/tests/structures.rs` `salts_are_unique` now checks **every** `pub const SALT_` in `rng.rs` (it checked only
those declared after the content-W1 comment) and lists all clashes at once instead of stopping at the first.

## Red first

Against the unchanged `rng.rs`, the extended test failed with exactly the eight known pairs and nothing else:
`docs/research/salts-red-first.txt` (the cargo output, `exit 101`):

```
salts declared twice: [
    "SALT_MUD_MOVE = SALT_GEN_BIOME = 260",
    ...
    "SALT_QUAKE = SALT_GEN_MUSH = 267",
]
```

After the renumbering it passes. The red test was not committed on its own: `CLAUDE.md` ("Never commit a red state")
outranks the brief's "a commit per step"; the saved red output is the evidence, and the test lands with the fix.

## Other places that hard-code the numbers

None. Searched all of `sim/` (and `shared/`, `client/`, `server/`, `tests/`) for the eight names, the literals
260-267 and arithmetic on salts. Every use goes through the named constant (`grid.rs` 858-953, `spells.rs` 236); the
literals 260-267 elsewhere are coordinates and depths. No TypeScript mirrors the rng (the only `salt` in `server/` is
`log.ts`'s IP-tag salt). The three unmerged branches that touch `rng.rs` (`x-boss`, `x-enemies`, `x-spells`) are the
pre-integration originals whose salts landed on `multa` under other numbers; none uses 291-298.

## Pinned results

**No pin moved, and none was re-recorded.** The full `cargo test --release --no-fail-fast` on the renumbered tree
(`/tmp/salts-cargo-prepin.log`: 478 passed, 0 failed, 53 binaries) reproduced every pinned result byte for byte:

| Pin | Scenario | Moved? | Why not |
|---|---|---|---|
| `golden.rs` `golden-v19.bin` | Survival S, seed 7, 600 ticks, casts [0,1,2,4] | no | casts Push, Blast, Water, Fire Bolt only |
| `golden.rs` `SCRIPTED_HASH` | Survival M, seed 1, 3000 ticks, Colossus | no | same casts; the boss makes no mud/salt/snow/thermite |
| `perf-trace.txt` sand_pour, water_flood, lava_water, fire_wood, bomb, mixed on/off | sandbox paints | no | paints Sand, Water, Lava, Fire, Wood, Rock, Dirt, Oil, Acid, Gas, Coal, Ice, Gunpowder, Seed, Empty |
| `perf-trace.txt` survival_l | Survival L, no casts | no | nothing cast |
| `perf-trace.txt` creative_m_spells | Creative M, casts [4,5,2,6,7,8,10,9,1,0] | no | never casts Quake (13) or Mudslide (14) |

This is what the uses predict, so it needs no investigation: the eight salts are read only inside `update_mud`,
`update_salt`, `update_snow`, `update_thermite` (`grid.rs`, dispatched only for cells of those four materials) and
`quake_cast` (`spells.rs`). Generation never places Mud, Salt, Snow or Thermite (`gen.rs` has none of them), the
only spell that makes one is Mudslide, and none of the pinned scripts paints one, casts Mudslide or casts Quake.
So the per-cell rolls that changed are never drawn in any pinned run. The behavioural tests that do use these
materials (`e3_spells.rs`, `m5_spells.rs`) assert rules and counts, not specific rolls, and pass unchanged.

A consequence worth recording: **the pins do not cover these eight rules at all**. A future change to Mud, Salt,
Snow, Thermite or Quake would also leave every pin green. (Listed under FUTURE ideas below.)

## Snapshot format: no bump

The snapshot (`sim/src/snapshot.rs`) stores cells, entities, players and the config; it holds no salt and no
derived roll. Generation is unchanged, so a snapshot means the same thing under both builds: the new build restores
an old snapshot to the identical state, and only the rolls of the next tick onwards differ. That is a rule change,
not a format change, so there is nothing to version.

**An in-flight stored world under the new build is safe**, by the existing D-014 / plan 9.3 path, not by luck. The
server's `simBuild` is the hash of the whole `sim.wasm` (`server/main.ts` 339), which a changed constant changes.
On a cold start `World.loadFromDb` (`server/world.ts` 505) sees `row.simBuild !== this.simBuild` and: verifies the
latest snapshot in the worker under the new build; if it restores at its tick, **clears the tick log** and carries on
from the snapshot (`world.build_changed` `kept_snapshot`); if it is refused, resets the world; if the verifier is
unavailable, refuses to start rather than reset. The old build's tick log is therefore never replayed under the new
rules, so there is no case where a stored log is re-simulated with different per-cell rolls than it was recorded
with. What is lost is the ticks since the last snapshot (at most one snapshot interval of play), which is the
designed cost of any sim deploy. Clients cannot mix builds either: invariant 10, the server refuses a client whose
hash differs. `tests/net/persistence.test.ts` ("a snapshot the new build can restore is kept", and the real-server
boot variant) covers the path. The game is not live, so even that loss is moot this week.

## Gate

Full tier (`node scripts/gate-plan.ts`: full because `sim/src/rng.rs`, `sim/tests/structures.rs`), run once on a
quiet host (load about 5.4, no other gate), the commit chained on the exit code (`gate exit 0`, commit `e81c715`):

| Step | Result | Log |
|---|---|---|
| cargo test --release | 478 passed, 0 failed (53 binaries) | `/tmp/salts-g-cargo.log` |
| clippy wasm32 -D warnings | clean | `/tmp/salts-g-clippy.log` |
| typecheck | clean | `/tmp/salts-g-tsc.log` |
| determinism (D1-D11, Node + 3 browsers) | 53 passed, 11 files | `/tmp/salts-g-det.log` |
| net | 558 passed, 1 skipped, 75 files | `/tmp/salts-g-net.log` |

`sim.wasm` built by the gate has 0 imports (invariant 4). The earlier pin check run (`--no-fail-fast`) is
`/tmp/salts-cargo-prepin.log`. The determinism suite has no pinned hashes (it compares engines with each other), so
it could not mask a pin move. No browser check: nothing visible changed, and no generated world changed.

## Spend

Week spend $397.79 at the start, $404.23 after the gate: about **$6.4** of the $8 cap, no workers. Most of it was
waiting through two full cargo runs (the pin check and the gate).

## FUTURE.md ideas (listed, not added)

- **A pinned scenario for the E3 materials and Quake.** No pin draws the eight renumbered salts: neither `golden.rs`
  nor `perf_equiv.rs` paints Mud, Salt, Snow or Thermite or casts Mudslide or Quake, so a behaviour change in those
  rules would pass every pin. A `perf_equiv` sandbox scenario that paints the four materials beside Water, Ice and
  Lava and a `players` run that casts 13 and 14 would close it (this change would then have moved exactly that
  scenario, which is the check this item wanted).

## Architectural decisions for review

- **New numbers 291-298** (the next free block), not reuse of a gap such as 137-139 or 146-199: one contiguous block
  next to the uniqueness test's tail is easiest to audit. Reversible at the same cost as this change.
- **Renumber the cell-rule eight, not the generation eight** (as the brief says): moving generation salts would
  change every generated world; moving cell rules changes only worlds that contain Mud, Salt, Snow, lit Thermite or
  a Quake.
- **The test parses `rng.rs` text** (as before) rather than a const array, so a salt added anywhere in the file is
  checked without anyone remembering to list it.

## D-row draft (an update to D-217, marking it closed)

| D-217 | 2026-11-08 | ~~Left as is for now~~ **Closed (branch `salts`)**: the eight spells' cell-rule salts moved from 260-267 to 291-298 (`SALT_MUD_MOVE`..`SALT_QUAKE`); the biome generation salts kept 260-267, so generated worlds are unchanged. `salts_are_unique` now covers every salt in `rng.rs` (shown red against the eight duplicates first, `docs/research/salts-red-first.txt`). No pinned result moved (none of `golden.rs` or `perf_equiv.rs` paints these materials, casts Mudslide or casts Quake), so nothing was re-recorded. No snapshot format bump: the snapshot holds no salts and generation is unchanged; a stored world under the new build keeps its verified snapshot and drops the old tick log (`loadFromDb`, plan 9.3), so no log is replayed under the new rolls. | The duplicate was a correlation, not a desync, but the "every salt unique" rule is only checkable if it has no exceptions. Report: `docs/research/salts-report.md`. |
