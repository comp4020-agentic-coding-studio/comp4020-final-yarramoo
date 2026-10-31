# Brief F2: more materials, more reactions, scattered through the caves

**Why:** the user played on 31 Oct and said the world "doesn't feel super responsive, not many materials
scattered around that create fun particle-simulation moments". There are 14 materials today, with only a
few reactions between them: lava and water make rock and steam, fire burns wood and plants and turns water
to steam, and gunpowder explodes. The generator places a few water and lava pools and some sand and
gunpowder piles. F1 (D-150, D-151) widened the caves and added chambers, so there's now room for things to
happen. This slice makes the caves full of things that react when a player pokes them. The game is not live,
so a world reset and a snapshot format bump (if one is needed) are fine. Don't build compatibility shims.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. Read `CLAUDE.md`
first; the sim invariants 1-11 and the harness rules are binding. In particular: no floats, counter-based
rng only with a new salt per use, bounded work per tick, sleeping must stay invisible (D7), `rm` only on
literal absolute paths, gate every commit on exit codes, show every new test red first, and don't push.
Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`.

## Materials to add (ids 15 onwards, appended, so existing ids never move)

Each new material needs an update rule in `sim/src/grid.rs` `update_cell`, a name in `shared/names.ts`,
a colour in `client/materials.ts`, and `paintable` coverage in `sim/src/materials.rs`. Keep each rule
cheap and local (4- or 8-neighbourhood, one move per tick), in the style of the existing `update_*`
functions.

1. **Oil** (liquid, lighter than water, so it floats on it). Flammable: it burns fast and spreads fire along
   its surface. Use `liquid_move`, then make Water/Oil density swaps work the way sand sinks through water.
2. **Acid** (liquid). It dissolves Rock, Dirt, Sand, Wood and plants on contact, by chance, using up the acid
   cell slowly (aux as a strength counter). It doesn't touch Bedrock or Glass. Acid plus Water dilutes:
   both become Water, by chance. Bound it: at most one dissolve per acid cell per tick.
3. **Gas** (flammable, rises like Smoke, lingers in pockets). Fire touching it becomes a fast flash-fire
   that spreads through the whole pocket. Optionally, a small explosion when it is dense (aux), but keep
   the explosion bounded through the existing `MAX_EXPLOSIONS_PER_TICK` path.
4. **Ice** (solid). Melts to Water next to Fire or Lava. Water next to Ice freezes by a small chance, but
   cap it: only when the ice cell's aux "cold" counter allows, so a lake doesn't freeze in a frame.
5. **Glass** (solid, inert). Sand next to Lava (or hit by a Fire bolt explosion) becomes Glass by chance.
6. **Coal** (powder or static solid, your choice; flag it). Flammable, but it burns long (aux life
   about 4x wood) and gives off smoke. It makes a good slow fuse.

If budget runs short, do them in this order and stop cleanly after any complete material:
**Oil, Acid, Gas, Ice, Glass, Coal**. Record in the report what was skipped.

**Existing interactions to check and extend:** fire meeting Oil, Gas and Coal; lava meeting Ice, Sand
and Oil; `Grid::dig` and `carve` handling the new solids (Ice, Glass and Coal should be dig-able; liquids
and gas left alone, the same as now); `is_flammable`; and `fill_empty_writable` (Gas counts as gas).

## Generation: scatter them

In `sim/src/gen.rs`, after F1's chambers and alongside the existing pools and piles:

- **Oil pools** in the shallow band, sometimes resting on water (a layered pool).
- **Acid pools** in the deep band, rare, never on the guaranteed traversal path (check how `try_pool`
  and the path set already avoid it).
- **Gas pockets:** fill the tops of some chambers with Gas, a few hundred cells each, held in by rock
  above.
- **Ice** in the shallow band near the surface: a few ice-lined chambers or frozen pools.
- **Coal seams:** thin veins in the rock of the shallow and deep bands (noise or worm-like), so digging
  sometimes hits them.

Count everything with `scale_count` so S and M worlds aren't swamped. Use a new `SALT_GEN_*` per pass.
`traversable_to_every_band` must stay green at every size. Keep acid off the path; a pit of acid on the
only way down would be a trap that rewards nothing. Keep `pickup_spots_are_on_floors_in_their_band` green.

## Client

- Colours for each new material. Water and Oil must read differently at a glance (oil dark amber, acid
  sickly green, gas faint translucent yellow-green, ice pale cyan, glass light blue-grey, coal near-black
  with a blue tint).
- **The palette uniform is `uPal[16]` in `client/render.ts`** and `paletteTable()` in
  `client/materials.ts` fills 16 entries. Material ids now go past 15, so grow both: to 32 is simplest.
  Check that the shader reads the material byte as an integer index with no other 16 assumption (grep
  `16` in `render.ts`).
- The sandbox palette (`MATERIALS`) lists the new materials, so players can paint them in the Sandbox and
  Creative.
- If `client/sfx.ts` gets an obvious hook (a hiss for acid dissolving), skip it. Sound for materials is a
  FUTURE.md idea, not this slice.

## Tests

- One sim unit test per reaction, in the style of `sand_sinks_through_water`: oil floats on water, acid
  eats rock and stops at bedrock, gas flash-burns, ice melts by fire, water freezes slowly, sand becomes
  glass by lava, coal burns long. Show each red first (an early `return` in the rule).
- **Bounded work:** a test that a world full of acid, or full of gas plus fire, keeps a tick within the
  existing perf bounds. Use whatever P1-style measurement exists; see `docs/research` and
  `sim/tests/sleep.rs`.
- **Sleeping (D7):** the existing sleep-invisibility tests must cover a scene with each new material.
  Extend `sim/tests/sleep.rs` or the determinism scripts so a sleeping chunk next to oil, acid, gas and ice
  gives identical results with sleeping on and off.
- The determinism suite must pass across Node, Chromium, Firefox and WebKit.

## Files you may touch

`sim/src/{materials,grid,gen,tuning,rng}.rs` (for salts), `sim/tests/*.rs`, `shared/names.ts`,
`shared/stats.ts` (only if it enumerates materials), `client/{materials,render}.ts`,
`tests/net/*.test.ts` and `tests/determinism/*` (update expectations only, never weaken a check),
`tools/` (determinism script inputs), `docs/art/shots/`, and your report. Don't edit `FUTURE.md`,
`docs/DECISIONS.md` or `docs/engineering-decisions.md`.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && git commit ...
```

Also run `pnpm test:net` (about 5 minutes) before the client commit and before the last commit.

## Look at it

`pnpm dev:client` prints its real port; vite ignores `--port` after `--`, so read the "Local:" line.
Use `agent-browser` through `zsh -ic`, with the viewport set to 1280x800 (`agent-browser set viewport
1280 800`). The canvas should be 960x540. If it's tiny, measure the layout with
`getBoundingClientRect` before blaming the browser (D-152).

- Save gen-preview screenshots of seeds 1 and 8 at L to `docs/art/shots/f2-caves-seed{1,8}.png`.
- In `/sandbox`, paint each new material and drive one reaction per material (oil on water and then
  fire; acid on rock; gas plus fire; ice next to lava). Screenshot to `docs/art/shots/f2-reactions-*.png`.
- **Look at each screenshot yourself** before citing it.
- Stop every vite you start, by PID.

## Commit checklist (commit each separately)

- [ ] 1. Oil: material, rule, tests, colour.
- [ ] 2. Acid: material, rule (bounded), tests, colour.
- [ ] 3. Gas: material, rule, flash-fire, tests, colour.
- [ ] 4. Ice and Glass: materials, melt/freeze and sand-to-glass, tests, colours.
- [ ] 5. Coal: material, slow burn, tests, colour.
- [ ] 6. Palette to 32 entries, the sandbox list, the sleep-invisibility coverage for the new materials.
- [ ] 7. Gen: oil pools, acid pools off the path, gas pockets, ice, coal seams; counts and timings per size.
- [ ] 8. Screenshots and the report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f2-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, and how you verified it;
- gen time per size before and after, and the open fraction;
- the count of each new material per seed at L;
- the bounded-work measurement;
- what you couldn't verify;
- **"Architectural decisions for review"**: material id order, how each aux byte is used, the density
  ordering of liquids, the freeze cap, Coal as powder or solid, and the palette size. For each: what you
  chose, the alternatives, why, and what it costs later. When unsure about something hard to reverse, take
  the more reversible option and flag it;
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Read `git diff <base>..HEAD -- sim shared client` cold. Check:

- that every rule has bounded work per tick;
- that there are no floats, `HashMap` or `usize` hashes;
- that every rng call has a unique salt;
- that sleeping can't diverge (a rule that reads a neighbour chunk but doesn't wake it);
- that acid can never sit on the guaranteed path;
- that the palette grew everywhere it's read;
- that no material can be created by a reaction that `paintable` or the snapshot can't represent.

Write the findings to `docs/research/review-f2.md`.
