# Brief F1: a starting Dig spell and roomy caves

**Why:** the user played the existing worlds on 31 Oct and found the caves too thin to move through, and found that
a player starts with nothing that destroys the world. They chose a **new unlimited Dig spell** (Blast goes back to
being a knockback cone) and **roomy caves** (main tunnels two to three bodies tall, plus open chambers). This is the
first of the "make the existing worlds fun" slices, before any new game modes. The game is not live, so world,
snapshot-format and protocol breaks are fine and need no compatibility shims.

**Worker:** one Sonnet worker, no subagents, about 80 tool calls. Read `CLAUDE.md` first: the sim invariants
(1-11) and the harness rules are binding. That includes the `rm` rule (a literal absolute path every time) and
gating each commit on exit codes.

## Part A: the Dig spell (spell id 6)

Append it as **spell id 6**, so the existing ids and stats keys stay stable. Put it on the bar as **slot 3** (key
3), right after Push and Blast; `client/spells.ts` `BAR` is a slot-to-id map, so the ids don't move.

- **Behaviour:** an instant cast like Blast (no projectile). It clears a **capsule**: a line from the chest along
  the aim, `DIG_REACH` = 14 cells long, with radius `DIG_RADIUS` = 7. This is body-wide with a margin, because the
  hitbox is 5x10. It removes the same materials `Grid::dig` removes now (Rock, Dirt, Sand, Wood, plants), leaves
  Bedrock and liquids, and primes Gunpowder. No damage, no knockback. Starting values: `COOLDOWN` 18 ticks,
  charges `INFINITE` from the start. All of these numbers go in `sim/src/tuning.rs`.
- **Bounded work (CLAUDE.md):** the capsule's box is at most (2r+1) by (reach+2r+1). Clamp the radius and the
  reach inside the grid function, as `dig` does now.
- **Blast stops digging.** Remove the dig from `blast()`, and remove or repurpose `BLAST_DIG_*` and their tests
  (`casts_to_dig_100_rows` becomes a Dig test: count how many Dig casts it takes to go 100 rows straight down;
  record the number).
- **Cause codes collide.** `EV_DEATH` causes are "spell id 0..NUM_SPELLS, then CAUSE_FIRE = 6, CAUSE_LAVA = 7,
  CAUSE_GUNPOWDER = 8", and `player_caused = cause < NUM_SPELLS`. Moving `NUM_SPELLS` to 7 makes 6 ambiguous.
  Renumber the environmental causes to a separate range (for example 32, 33, 34) in `sim/src/tuning.rs` and
  `shared/sim.ts`, and check every reader: `client/toasts.ts`, `shared/achievements.ts`, the server's claim
  handling (grep `cause` in `server/`), and the tests.
- **Everything sized by `NUM_SPELLS` changes:** the player record (`PLAYER_BYTES`), the HUD view, `START_CHARGES`,
  `PICKUP_CHARGES` (0 for Dig), `SPELL_ENABLED`, `COOLDOWN`, `SPEED`, `GRAVITY_Q8`. Also check `config.rs`
  `all_spells()` and the Creative "all spells" path in `sim.rs`, `BAG_SPELLS` (bags still hold only the four
  finite spells; Dig is not bagged), `shared/names.ts` `SPELL_NAMES` (add "Dig"), `client/spells.ts` (a colour,
  for example earthy `[0.7, 0.5, 0.3]`), the stats keys in `shared/stats.ts`, and
  `tests/net/spells-table.test.ts`.
- **Snapshot format:** the player record grows, so bump `FORMAT_VERSION` in `sim/src/snapshot.rs` from 4 to 5. Old
  snapshots get refused, which is fine because nothing is live. Check what the server does with a stored snapshot
  of the wrong format at boot (D-112): it must not stop the server. If it would, record that as a finding; don't
  build a shim.
- **Client:** cast fx for spell 6 in `client/worker.ts` `spellFx` (a dust cone along the capsule, using the
  existing `fx.cone` or a new small fx function). The cast-preview ghost must not try to fly a projectile for Dig;
  see how Blast (speed 0) is handled. The sound and juice slice may already have added a sound per spell in
  `client/sfx.ts`. If it has, add a Dig sound in the same style (a gritty crunch); if not, skip sound.
  The juice slice also added a **Blast dig preview** outline. Move it to Dig (a capsule outline), since Blast no
  longer digs.

## Part B: roomy caves

The traversal guarantee (`traversable_to_every_band` in `sim/src/gen.rs`) stays green at every size.

- Worm radii: entrance shafts and links go from `r 5-9` (start 7) to about **`r_min` 10, `r_max` 16, start 12**.
  Scale them with `Scale` at sizes S and M (512 and 1024 wide) so small worlds aren't solid tunnel.
- **Chambers:** add a pass that carves some open caverns, with radii of roughly 25-45 cells, joined to the worm
  network. A few in the shallow band and more in the deep band, counted with `scale_count`, using counter-based
  rng with a new `SALT_GEN_*`. Keep the deep band's pickups (`pickup_spots_are_on_floors_in_their_band`) and the
  pickup counts sensible. Re-read the pickup-spot rules, because more open space changes how many floors there are.
- Check the material piles and pools (sand, gunpowder, water, lava, trees) still land somewhere sensible, not
  floating in a void.
- Generation time: measure native release gen time per size before and after (the R1 figures were S 85 ms, M 92
  ms, L 246 ms), and report both.
- **Look at it:** `client/gen-preview.html` via `pnpm dev:client` (pick a free port, for example `--port 5182`),
  using `agent-browser` through `zsh -ic`. Save before and after screenshots of seeds 1 and 8 to
  `docs/art/shots/f1-caves-*.png`. Then open `?world=game&avatar=1`, walk into a cave, and dig with Dig. Save a
  screenshot to `docs/art/shots/f1-dig.png`. Kill every vite you start, by PID.

## Files you may touch

`sim/src/{tuning,spells,grid,gen,entities,snapshot,sim,config}.rs`, `sim/tests/*.rs`, `shared/{sim,names,stats,
achievements}.ts` (only for cause codes and the spell count), `server/` (only the claim cause handling, if
needed), `client/{spells,worker,toasts,fx,sfx}.ts` and `client/room.ts` (bar or HUD slot only),
`tests/net/*.test.ts` and `tests/determinism/*` (update expectations only, never weaken a check),
`docs/art/shots/`, and your report. Don't edit `FUTURE.md`, `docs/DECISIONS.md` or
`docs/engineering-decisions.md`; the session model writes those.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && git commit ...
```

Run `pnpm test:net` (about 3 minutes) before commits that touch `shared/`, `server/` or `client/`, and before the
last commit. Never chain a commit with `;`. A new test must be shown red without its fix first (say how in the
report). Don't push; the session model reviews and pushes.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Commit checklist (commit each separately)

- [ ] 1. Renumber the environmental cause codes (sim and TS, every reader, tests). No behaviour change.
- [ ] 2. Spell 6 Dig in the sim: tuning arrays, the capsule dig in `grid.rs` with a bounded-work test, cast
      wiring, Blast stops digging, snapshot format 5.
- [ ] 3. Shared and client: names, spell table, bar slot, fx, the moved preview, a sound if `sfx.ts` exists,
      `spells-table` test.
- [ ] 4. Caves: wider worms, scaled by size.
- [ ] 5. Caves: chambers, pickup and material checks, before and after gen timings.
- [ ] 6. Screenshots and the report.

## Report

Write `docs/research/f1-worker-report.md` as you go, not only at the end. It should cover:

- per commit: the hash, what changed, and how you verified it;
- Dig casts to dig 100 rows; gen timings before and after; the pickup counts per band before and after;
- what you couldn't verify;
- a section **"Architectural decisions for review"**: each choice later work builds on (the cause-code range,
  where Dig sits in the id space and the bar, the capsule shape, the chamber pass's place in the gen pipeline),
  with what you chose, the alternatives, why, and what it costs later. When unsure about something hard to
  reverse, take the more reversible option and flag it;
- ideas for FUTURE.md, suggested only.

## Independent review (after the worker, by a separate Sonnet reviewer)

Read `git diff <base>..HEAD -- sim shared server` cold. Check:

- that the capsule dig is bounded;
- that no float arithmetic, `HashMap` or `usize` hash crept in;
- that every reader of a cause code was updated;
- that the snapshot format bump covers every changed record;
- that `NUM_SPELLS`-sized arrays agree between Rust and TS;
- that chamber carving can't make `repair_traversal` or pickups misbehave.

Write the findings to `docs/research/review-f1.md`, each with file:line and a severity.
