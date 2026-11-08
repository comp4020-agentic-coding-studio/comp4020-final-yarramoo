# Brief HF: snapshot format 12, named state instead of packed fields

**Why:** three pieces of hashed state hide in fields that were built for something else. Each one has already
needed a comment to explain it, and each is a trap for the next person to touch the boss or the round.
- `Sim.round_started` is a bit set: bit 0 `ROUND_RUNNING`, bit 1 `ROUND_BOSS_KILLED` (`sim/src/tuning.rs:359-363`).
- The boss's phase lives in `Enemy.state` bits 2-3 (`sim/src/enemy.rs:184-188, 375-387`; bits 0-1 are the
  hunting and airborne flags).
- The boss's summon counter lives in its `hop_until` (`sim/src/enemy.rs:116-138`, `entities.rs:203-208, 466-468`).

The game is not live, so a format break is fine. This is the last cheap chance before launch.

**Worker:** one Sonnet worker on `multa` in `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`.
Use no subagents, and stay within about 100 tool calls. Rules:
- the binding rules in `CLAUDE.md` (read the invariants);
- every commit gated on exit codes chained with `&&`; **never pipe a gate through `grep`**;
- red-first tests where a test is meant to catch something;
- `rm` only on literal absolute paths;
- **no pushing**; never weaken a test;
- prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`;
- run single test files while iterating, and the full gate once per commit, in the background;
- before you finish, `pgrep -fl "vite.js|server/main"` and kill anything you started, by PID.

Other workers run at the same time in `/tmp/wt-*` worktrees. Don't touch them. Touch only these files:
`sim/src/**`, `sim/tests/**`, `sim/examples/**`, `shared/sim.ts`, `shared/**` only where the entity view's
layout forces it, `client/worker.ts` (the `devbosshp` snapshot patch, which hard-codes the enemy record
layout), `client/**` only where an entity field's meaning changes, `tests/net/**`, `tests/determinism/**`,
`server/db.ts` (only its expected snapshot format, if it has one), `docs/DECISIONS.md`,
`docs/engineering-decisions.md`.

## What to change

1. **The round:** replace `round_started`'s bits with named fields, e.g. `round_running: bool`/`u8` and
   `boss_killed: u8`. `round_over` and `round_result` stay. Remove `ROUND_RUNNING` and `ROUND_BOSS_KILLED`.
2. **The boss:** give `Enemy` explicit fields, e.g. `phase: u8` and `summons: u16` (or `u8`, if
   `BOSS_SUMMONS_TOTAL` fits; say which). `state` keeps only bits 0-1 for every kind. `hop_until` means only
   the next hop, for every kind. Non-boss enemies write zeros in the new fields, and restore refuses non-zero
   there. Update `ENEMY_BYTES`.
3. **The snapshot:** `FORMAT_VERSION` 12, one bump for all of it. Write and read must stay symmetric, restore
   must validate the new fields (phase in 0..=3, summons within the existing bound), and the doc comment's
   version history gets a v12 line.
4. **The hash:** the new fields go into the state hash in a fixed order, as fixed-width integers (invariant 7).
   The hash value changes; that is expected. If any test pins a hash value, update it with a note in the
   commit message that the format changed, not because it was red.
5. **The entity view** (what the client reads): if the boss's phase is read from `state >> 2` anywhere in
   `client/` or `shared/`, change it to the new field and keep the view's layout test in step.

## New tests

- **A golden snapshot:** a fixed world (seed, config, size S Survival), a scripted input list run to a fixed
  tick, its snapshot bytes written to `sim/tests/fixtures/golden-v12.bin` (a small file; S world is fine), and
  a test that the same run reproduces those bytes exactly and that restoring them reproduces the hash. Add a
  one-line comment that a deliberate format change regenerates the file (with an env var or an ignored test
  that writes it) and says how.
- **A scripted-run hash:** a longer scripted Survival run (lobby ready, the round starting, a few casts and
  kills) whose final state hash is pinned as a constant. This catches an accidental behaviour change that the
  per-feature tests miss.
- **The boss's named state survives restore:** snapshot mid-fight at phase 2 with some summons spent, restore,
  step both copies N ticks, and compare hashes every tick. Show it red against a deliberately broken restore
  (for example, skip reading `summons`) before you fix that back; say in the report that you did.

## Commit checklist (one commit each)

- [ ] Round fields named (`round_running`, `boss_killed`), constants removed, all readers updated.
- [ ] Boss `phase` and `summons` named; `state` and `hop_until` mean one thing each.
- [ ] Format 12: snapshot write/read/validate, hash order, the doc comment, any TS view or dev hook.
- [ ] Golden snapshot and scripted-run hash tests.
- [ ] `docs/DECISIONS.md` row D-183 (what changed and why), and an `engineering-decisions.md` entry only if
      something surprising turned up.

## The gate (every commit)

```
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

The full gate takes about 8 minutes. Write each step's output to a file under `/tmp/hf-*.log` if you need to
read it; don't pipe it.

## Report

Write `docs/research/hf-worker-report.md`: what changed, the commits, the gate results with counts, anything
you couldn't do, and a section **"Architectural decisions for review"**: each choice later work builds on
(field widths, the golden file's world, where the hash order puts the new fields), with the alternatives,
why, and the later cost. Suggest FUTURE.md ideas there, if any. Don't edit FUTURE.md yourself.
