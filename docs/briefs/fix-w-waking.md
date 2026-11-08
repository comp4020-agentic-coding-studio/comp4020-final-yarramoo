# Brief W: frozen chunks wake when something reaches them (no cap), then a load test

**Why:** playtest note 3. Liquid that crosses the edge of the active region (576 x 320 around each player,
`Grid::set_active_around`) freezes there, hanging in mid-air. It was seen in a browser with the new overlay
(`docs/art/shots/activebox-water-stops-at-box-edge-zoom.png`, D-173). **The user's decision (3 Nov):**
- a frozen chunk wakes when anything changes a cell next to it: liquid, gas, fire, growth or a reaction;
- **no cap** on how many chunks wake;
- measure the load afterwards to see whether a limit is needed.

Read these first:
- `CLAUDE.md` (the sim invariants are binding);
- plan section 6.5 (`docs/plan.md`);
- D-054, D-172 and D-173 in `docs/DECISIONS.md`.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. Rules:
- `CLAUDE.md`;
- red-first tests;
- gate on exit codes chained with `&&` (never `;`, never through `grep`);
- `rm` only on literal absolute paths;
- **no pushing**;
- never weaken a test;
- stop any vite or server you start.

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Run single test files while iterating, and the full gate once per
commit. `pnpm test:net` takes about 8 minutes, so run it in the background.

## The design (follow it; flag anything that doesn't work)

Today `step_cells` skips every chunk with `!active[c]` and forces `awake[c] = true` so it runs when it
becomes active (`sim/src/grid.rs`, around line 326). `awake` is scratch state today: not hashed and not
snapshotted, because sleeping is invisible (invariant 8). That stays true **inside** the active set.

New rule: **a chunk runs on a tick if it is active, or if it is "woken"**.

- **Woken:** a chunk outside the active set is woken when a running chunk changes one of its cells, or a
  cell within one cell of its edge. That's exactly what `touch` already detects for its neighbour wake. It
  stays woken while its own run keeps changing cells or sees volatile material (the same rule a chunk uses to
  stay awake today). It goes back to frozen once it runs a tick with no change and no volatile material.
- **Inside the active set,** behaviour is as today: sleeping stays an invisible optimisation (D7 must still
  pass, including the new liquid tests).
- **Outside the active set,** the woken flag decides **what happens**, so it's **semantic state**. Keep it in
  a separate vector (for example `woken: Vec<bool>`) rather than reusing `awake`, so `awake` stays pure
  scratch. `woken` is:
  - part of the **state hash**: fold it into the hash however is cleanest, for example a per-chunk byte in
    `chunk_hashes`, or a separate bitset appended in `state_hash`; say which;
  - part of the **snapshot**: bump `FORMAT_VERSION` 9 to 10 and `SNAPSHOT_FORMAT_VERSION` in `server/db.ts`;
    a net test pins them. Restore accepts exactly one version, which is fine while the game isn't live;
  - **cleared** when its chunk becomes active (an active chunk runs anyway) and **not** set by being near a
    player. Frozen chunks a player walks away from stay frozen as today, unless something is still moving in
    them. **Decide and flag:** should a chunk that leaves the active set while something in it is still
    moving (awake) become woken, so a flow the player walked away from finishes? The user's goal ("see how
    the world goes when not limited") suggests yes. Implement that unless it breaks something, and say so.
- **Fire, growth, reactions:** all already `touch` the cells they change, so they spread waking through the
  same rule. No per-material list is needed. Check that volatile materials in a woken chunk keep it woken
  (they set `vol_seen`).
- **No cap.** Work per tick is still bounded by the grid size (every chunk at most once), which is the
  invariant's real requirement. Say so in the report.
- **With sleeping disabled** (`sleep_enabled = false`, a dev switch), every chunk in the active set runs
  every tick. Outside it, the woken rule must still apply **identically**, otherwise turning sleep off would
  change results. Test this.
- **Sandbox** (all chunks active) is unaffected.
- **Enemies** keep their own rectangle (`ENEMY_ACTIVE_W`); don't change enemy stepping.

## Tests (red first)

- `sim/tests/liquid_walls.rs`: the existing test that shows a water front **freezing** at the active
  region's chunk edge flips. Water released next to the edge must now flow on into the frozen region and
  settle (no face hanging over air). Show it red before the change, then green. **This flips a test
  deliberately:** say so in the commit message and report, and keep the old assertion's intent in a comment.
- A frozen chunk that nothing reaches stays frozen (its cells unchanged, `ran_chunks` unchanged).
- Fire spreading out of the region keeps burning in woken chunks. A seed growing across the edge keeps
  growing.
- Woken chunks return to frozen once settled (a count of woken chunks drops to 0 after a flow settles).
- **Determinism:** a snapshot taken while chunks are woken, restored, then run on, must hash identically to
  the uninterrupted run (D5-style; follow the existing pattern in `sim/tests/`).
- Sleep on and off, identical, in a game world, with a flow crossing the region's edge.
- Pin the D2 four-engine run with a script that crosses the edge if it's cheap. Otherwise say why not.

## Load test (after the change)

Write `sim/examples/wake_load.rs` (`cargo run --release --example wake_load`), modelled on `examples/perf.rs`.
Native step-time p50, p95 and max, plus the count of chunks run per tick, for:
1. a size-L Survival world (2048 x 1536, the largest), one player at the surface, 5 minutes of ticks (18000)
   with no disturbance (the baseline);
2. the same world with a large flood released at the surface that drains down every chasm;
3. the same world with a large fire in the surface forest and grass, if there is fuel; and with lava poured
   into a cave;
4. the worst case you can build: water and lava released across the whole width at once.

Report per scenario: p50, p95 and max ms per step natively; the peak and mean chunks run; and the tick at
which woken chunks return to 0 (if they do). Then estimate the browser cost. Native vs wasm in Chrome has
been measured before in this repo; find the ratio in `docs/research/` or `docs/DECISIONS.md`, or measure one
scenario in wasm through `node` and `shared/sim.ts`. State the 16.7 ms frame budget explicitly. Put raw
numbers in `docs/research/wake-load-results.md`. **Don't add a cap.** Give the numbers and a recommendation.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

## Commit checklist (commit each separately)

- [ ] 1. Tests, red: the flipped edge test, plus the woken-rule tests (ignored if they can't compile yet,
      like slice A did).
- [ ] 2. `woken` state, the rule in `step_cells`, the hash, the snapshot format 10 and the db mirror. Tests
      green.
- [ ] 3. `examples/wake_load.rs` and `docs/research/wake-load-results.md`.
- [ ] 4. Your report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Files you may touch

- `sim/src/{grid,sim,snapshot,hash,lib}.rs`, `sim/tests/*.rs`, `sim/examples/wake_load.rs`;
- `server/db.ts` (the format mirror only);
- `shared/sim.ts` (only if a telemetry export is added, for example a woken-chunk count, which is read-only
  and never an input);
- `tests/determinism/*` (expectations only);
- your report and the results file.

Nothing else in `client/` or `server/`.

## Report

Write `docs/research/fix-w-waking-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence;
- the load numbers (a summary; the raw numbers go in the results file);
- what you couldn't verify;
- **"Architectural decisions for review":**
  - where `woken` lives;
  - how it's hashed;
  - the snapshot layout;
  - the rule for chunks leaving the active set;
  - interaction with `sleep_enabled`.

  For each: what you chose, the alternatives, why, and what it costs later.
- FUTURE.md ideas, suggested only.
