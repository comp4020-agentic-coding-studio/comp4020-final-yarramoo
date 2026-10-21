# Brief R1: terrain for every config

Written 22 Oct morning by the session model, after R0a landed and was pushed (`multa` at `a81e1df`). Milestone R1
of `docs/plan-game-modes.md`: gen v2 for Caves at every size, Solid box, Empty box at every size, the traversal
test red-then-green for every terrain/size combination it applies to, and the starting dig.

**Dispatch:** one Sonnet worker, medium effort, about 80 tool calls. Review is lighter than R0a's: not a
structural ABI/snapshot change, so no independent reviewer — the session model checks the gen output by eye in
`client/gen-preview.html` plus the gate, per the plan's own review column for R1.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. Read `CLAUDE.md` first (sim
invariants are binding: integer-only, no floats, no HashMap, no usize in hashes, no host imports). Then
`docs/plan-game-modes.md` sections "Config fields", "Presets" and "Caves: gen v2 everywhere". Then
`docs/research/cave-gen-v2.md` (diagnosis of why today's caves aren't walkable, and the four starting-dig options
with their costs — option 2, "Blast carves soft materials", was chosen and already shipped on 21 Oct, see below).
The game is not live: generation output changing is fine, nothing to preserve. Rust needs
`PATH="$HOME/.cargo/bin:$PATH"`. Every `rm` names an explicit literal absolute path. Never use port 8080.

## What exists already (don't redo it)

- **R0a** (just landed) put a 16-byte `RoomConfig` behind the sim ABI. `sim/src/config.rs` has `terrain` (0 Caves,
  1 Solid box, 2 Empty box) and `size` (0 S 512x512, 1 M 1024x768, 2 L 2048x1536). Read it before touching
  anything — `Sim::new_with_base` in `sim/src/sim.rs:54-100` is where terrain is dispatched, and today only two
  combinations work: `TERRAIN_CAVES` at `size == 2` (generates via `gen::generate`), and `TERRAIN_EMPTY_BOX` at
  `size == 0` (bedrock floor and walls, today's sandbox). Every other combination returns `None` from `init`
  ("refused" — tested in `tests/net/room-abi.test.ts`).
- **Gen v2's traversal fix already landed** (`ec188a0`, 21 Oct): link worms widened to `r_min` 5, a
  `repair_traversal` pass that floods a 6x11 box from the sky and carves radius-6 shafts to y=1420. The test
  `traversable_to_every_band` (`sim/src/gen.rs:1082`) is **already un-ignored and green** for Caves at size L
  (seed 1..8, today's only Caves size). **Your job is not to redo this** — it's to make the same guarantee hold at
  sizes S and M, and to build Solid box and Empty box at every size.
- **The starting dig already landed** (`915bf34`, `706b381`, 21 Oct): Blast now carves a radius-4 disc 6 cells
  along the aim (`BLAST_DIG_RADIUS`/`BLAST_DIG_REACH` in `sim/src/tuning.rs`), clearing Rock, Dirt, Sand, Wood and
  plants, leaving Bedrock and liquids, priming gunpowder. Confirmed working in the browser
  (`docs/art/shots/blast-dig-2026-10-21.png`). **Don't rebuild this** — only touch it if a terrain you add needs a
  different interaction (e.g. Solid box's Dirt-over-Rock should already dig fine with the existing Blast code,
  since it clears Rock and Dirt both; verify this with a test, don't assume).
- Known cosmetic weakness, logged in FUTURE.md, not your job: the repair shafts read as pipes (backbone worms are
  the fix, left for later polish).

## What to build

1. **Caves at sizes S (512x512) and M (1024x768).** `gen::generate` currently has size assumptions baked in via
   `SHALLOW_TOP`/`DEEP_TOP`/`TARGET_SPOTS` tuned for the 1536-tall L world — read `sim/src/gen.rs` fully before
   changing anything, since bands, entrance counts, worm counts and pickup counts are likely tuned to L's height
   and width. Scale or re-tune them sensibly for S and M (half and three-quarter height respectively), rather than
   running the same absolute-pixel constants into a much shorter world. `Sim::new_with_base`'s guard
   (`sim.rs:62`, `cfg.size != 2`) needs removing for Caves, replaced with genuinely generating at all three sizes.
   `repair_traversal`'s target depth (1420) and the traversal test's target (1380) are tuned to L's 1536 height —
   these need their own per-size targets (the deep band should still be reachable, scaled to the size's height).
2. **Traversal test for every Caves size.** Extend (don't duplicate the logic of) `traversable_to_every_band` to
   run for sizes S, M and L, each with its own target depth proportional to that size's height. Show it red first
   against the un-scaled generator before your scaling fix, the way the 21 Oct worker showed the original red.
3. **Solid box terrain**, every size. Per the plan: "Dirt over Rock, for digging and carving." A simple layered
   fill (e.g. a shallow Dirt layer over Rock below it, Bedrock floor and walls, the same wall/floor convention
   `TERRAIN_EMPTY_BOX` already uses) — this does not need gen v2's cave algorithm, just a static layered fill
   function, analogous to the existing `TERRAIN_EMPTY_BOX` arm in `Sim::new_with_base`. No traversal test needed
   (there's no path to guarantee — it's an open-ish dig-through-anything arena), but write a basic test that
   confirms a player can dig from the surface to the floor with the existing Blast/Bomb carving (sanity, not a
   flood-fill proof).
4. **Empty box terrain at sizes M and L** (today only works at S). Same bedrock-floor-and-walls convention,
   just sized up. `Sim::new_with_base`'s guard (`sim.rs:86`, `cfg.size != 0`) needs removing.
5. **Keep the two existing presets (`classic_sandbox`, `caves_pvp`) byte-identical to today.** This is the same
   requirement R0a had: don't change what seed 42 kind 0 or seed 5 kind 1 produce. Diff baseline hashes before and
   after your change the way the R0a worker did (`sim/examples/` scratch binary, removed before your final commit,
   or an ignored test — either way, don't leave debug scaffolding in the tree).
6. **`client/gen-preview.html`** (dev-only page, already exists per D-124) should let you preview any
   terrain/size combination, not just Caves L. Check it still builds/runs; extend its controls if it's hardcoded
   to one combination, so the session model can eyeball every new terrain/size pair before this lands.

## What NOT to build (later milestones' job)

- Rooms, the server-side room table, lazy load/unload — that's R2.
- The menu, create-room UI — R3.
- Creative brushes, Deathmatch/Survival rules (`death`, `round`, `pickup_respawn` wiring) — R4-R6.
- `max_players` enforcement — flagged as D-138, someone else's job later.
- Backbone-worm cosmetic polish for the repair shafts — already in FUTURE.md, not R1's job unless trivial.

## Verify

- **Red first:** the traversal test at sizes S and M must be shown failing against the un-scaled generator before
  your fix (same pattern R0a and the 21 Oct gen-v2 work used).
- **Presets unchanged:** baseline hashes for `classic_sandbox()`/seed 42 and `caves_pvp()`/seed 5 at ticks
  0/40/80/120 identical before and after your change.
- **Every (terrain, size) combination either generates and passes a sanity check, or is a deliberate `None`** —
  don't leave a combination silently broken. If you decide a combination genuinely isn't buildable in this slice
  (say so and why in your report, then leave `init` refusing it, tested).
- **Gate every commit on exit codes:**
  `(cd sim && cargo test --release && cargo clippy --release --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown --release -- -D warnings) && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...`
- `sim.wasm` imports nothing (CI and the D-suite check it).
- **Boot the real Docker image** and run `APP_URL=http://localhost:8093 pnpm check`. Both existing worlds (0 and
  1) must still work exactly as before. Then `docker rm -f`/`docker rmi` by literal name.
- Gen time matters: caves generation was about 250 ms native, 345 ms in the browser preview at size L before this
  work (D-088 era numbers) — check size M and S don't regress proportionally worse than their smaller grids would
  suggest; note any surprising cost in your report.

## Files you may touch

`sim/src/{gen.rs, sim.rs, tuning.rs, config.rs (only if a terrain/size helper belongs there)}`,
`sim/tests/*.rs` (new tests only, plus the existing traversal/gen tests you're extending),
`client/gen-preview.html` and any TS it needs for multi-size/terrain preview controls,
`tests/determinism/*` (new tests/fixtures only), `tests/net/*` (new tests only, e.g. extending `room-abi.test.ts`'s
refusal list as combinations stop being refused).

Don't touch `shared/room.ts`'s config layout, `shared/sim.ts`, `shared/protocol.ts`, `server/*`, or
`client/{worker.ts,main.ts,lockstep.ts}` — R1 is sim-and-generator-only; the protocol and room plumbing are R2.

## Commits (checklist; each gated)

1. [ ] Red: traversal test at sizes S and M, failing against today's generator
2. [ ] Caves at sizes S and M: scaled bands/targets, test green, preset hashes for L unchanged
3. [ ] Solid box terrain, every size, with a dig-sanity test
4. [ ] Empty box terrain at sizes M and L (S unchanged, preset hash unchanged)
5. [ ] `client/gen-preview.html` extended for every terrain/size combination
6. [ ] Docker boot plus `pnpm check` (no commit unless a fix is needed)

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews and pushes.

## Report

Write to `docs/research/r1-worker-report.md` as you go (append per commit, not only at the end). Include: what
changed per commit, red-then-green evidence, determinism results, the Docker check, gen-time measurements per
size, screenshots or a description of what you saw in `gen-preview.html` for each new combination (the session
model can't run a browser itself without delegating that too, so describe what the preview shows plainly enough
to judge by eye), a section **"Architectural decisions for review"** (how you scaled the bands/targets per size
and why, anything hard-to-reverse you were unsure about, where you took the more reversible option and flagged
it), and any FUTURE.md ideas written directly into `FUTURE.md`.
