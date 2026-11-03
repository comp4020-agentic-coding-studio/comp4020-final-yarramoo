# Brief A: liquids (chunk-edge walls, skittering droplets)

**Why:** the user's priority #1 from the 3 Nov playtest. Read `docs/playtest-2026-11-03.md`, notes 3 and 4,
and look at `docs/art/playtest-2026-11-03/liquid-walls-1.png`, `liquid-walls-2.png` and
`lone-droplets.png`. Also read `CLAUDE.md` (the sim invariants are binding) and D-054, D-081 and D-082 in
`docs/DECISIONS.md`.

The two shots were taken while the client was current (28-61 ticks of lag, from the server log), so this is
real sim behaviour, not catch-up.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. Rules:
- `CLAUDE.md`;
- red-first tests;
- gate on exit codes chained with `&&`;
- `rm` only on literal absolute paths;
- **no pushing**;
- never weaken a test;
- stop any vite or server you start (`pgrep -fl "vite.js|server/main"` before you finish).

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Run single tests while iterating:
`cargo test --release --test <file>` or `cargo test --release <name>`. Run the full gate once per commit.

## 1. Walls of liquid on chunk edges: find the cause first

- **Symptom:** water and lava end in vertical faces and flat steps on 64-cell chunk boundaries, hanging
  next to air.
- **Two candidates:**
  - **The active region:** `Sim::refresh_active`, `Grid::set_active_around`, 576 x 320 around each active
    player (`tuning.rs`). Chunks outside it are frozen. The client's view is 480 x 270 cells at zoom 1, so
    frozen chunks can sit just past the view edge, and inside it whenever the player has moved since.
  - **Chunk sleeping** (`Grid::touch`, the `awake` loop in `step_cells`). Sleeping must be invisible
    (invariant 8).
- **Write native tests** (`sim/tests/`) that reproduce a wall, and find out which it is:
  1. A game world (`world_kind` with players, a seed of your choice) and one player. Put a water body
     against a solid wall that straddles a chunk edge, then remove the wall with a `Paint` of Empty (use the
     `dev_paint` feature, or a direct grid write in a native test). Run it with sleeping on, then off. If the
     results differ, that's an invariant-8 bug: add it to the D7 set (`sim/tests/sleep.rs`), shown red.
  2. The same setup with the wall just outside the player's active rectangle, then move the player (a Pos
     input) so the region shifts. Show whether a front freezes on the region's chunk edge.
  3. If neither reproduces it, look for a third cause in `liquid_move` or `slide`: the chunk-ordered sweep,
     the `moved` skip, or the odd/even direction. Say what you checked.
- **Then:**
  - **If it's sleeping, or any other plain bug:** fix it in `sim/`, and keep the test.
  - **If it's the active region:** **don't change the region's rules.** That's a design decision for the
    user. Write up the evidence and the options in your report (a bigger rectangle, a gravity-only band, a
    capped liquid wake-up outside the region, waking ahead of movement, dimming frozen chunks on the client)
    with the per-tick work each costs, and stop slice 1 there. Go on to slice 2.

## 2. Skittering droplets: give liquids a resting state

- **Symptom:** a lone liquid cell on flat ground random-walks forever. `Grid::liquid_move` picks a random
  side every update, and `slide` moves it up to `reach` cells (water 6, oil 5, acid 4, lava 3). It also
  keeps its chunk awake.
- **Wanted:**
  - a lone cell, or a one-cell film, on a flat floor stops moving;
  - liquid clings to liquid: a cell doesn't slide away from its own body onto bare ground unless something
    pushes it (liquid above it, or a drop within reach);
  - deep heaps still level fast.
- **Pick the rule yourself.** For example: slide only if the cell has liquid above it, or the slide reaches a
  gap below within `reach`, or a same-side neighbour is pushing. Keep it integer-only, using the
  counter-based rng only, bounded, and with a fixed scan order.
- **Tests, red first:**
  - one water cell and one lava cell on a flat floor in an otherwise empty sandbox stop moving within N ticks,
    and their chunk sleeps (`ran_chunks` drops);
  - a short 1-deep water film stops;
  - `lava_heap_levels_in_the_sandbox` (`sim/tests/determinism.rs`) and `water_levels_out` stay green
    **unchanged**;
  - D7 passes.
- This changes every hash. Update determinism expectations only where the suite fails because of the
  deliberate rule change, and say which ones.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

`pnpm test:net` takes about 8 minutes, so run it in the background, once per commit.

## Commit checklist (commit each separately)

- [ ] 1a. The reproduction tests for the walls (red if it's a bug; documenting if it's the active region).
- [ ] 1b. The fix, if it's a bug and not the region.
- [ ] 2a. The droplet tests, red.
- [ ] 2b. The resting-state rule, with tests green and expectations updated.
- [ ] 3. Your report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Files you may touch

- `sim/src/grid.rs`, `sim/src/tuning.rs` and `sim/src/sim.rs` (only if the cause is there);
- `sim/tests/*.rs`, plus `tests/determinism/*` (expectations only);
- your report.

Nothing in `client/`, `server/` or `shared/`.

## Report

Write `docs/research/fix-a-liquids-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence (paste the failing assertion);
- **the cause of the walls**, with the evidence;
- before and after for the droplets (ticks to rest, `ran_chunks`);
- what you couldn't verify;
- **"Architectural decisions for review":** the resting rule (what you chose, the alternatives, why, and
  what it costs later), and anything about the active region.
- FUTURE.md ideas, suggested only.
