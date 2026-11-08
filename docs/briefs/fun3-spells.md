# Brief F3: new spells, stronger deeper

**Why:** the user's 31 Oct playtest found "too few spells" and "no reason to go deeper". Research
(`docs/research/spells-ideas.md`) shortlisted Noita and other-game spells. On 31 Oct the user said to go with
the recommendations, spells first, then enemies. The session model picked the six below because each one
fits a shape the engine already has (an instant cast, a lobbed projectile with an impact effect, or an area
material change) and plays off F2's materials. The game is not live, so a snapshot format bump is fine.
Don't build compatibility shims.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 110 tool calls. Read `CLAUDE.md`
first; the sim invariants and harness rules are binding (no floats, counter-based rng with a new salt per
use, bounded work per input and per tick, `rm` only on literal absolute paths, every commit gated on exit
codes chained with `&&`, every new test red first, no pushing). Prefix cargo with
`PATH="$HOME/.cargo/bin:$PATH"`. Read `docs/research/f1-worker-report.md` first: F1 added spell 6 (Dig) and
lists every place that grows with `NUM_SPELLS`. Follow the same trail.

## The spells (ids 7-12, appended)

| id | name | tier | shape | effect |
|---|---|---|---|---|
| 7 | **Acid Flask** | shallow pickup | lobbed (like Water) | On impact, fills up to about 50 Empty cells around the impact with ACID (like `burst_water`). |
| 8 | **Oil Flask** | shallow pickup | lobbed | The same with OIL, about 70 cells. Pairs with Fire. |
| 9 | **Wall** | shallow pickup | instant, like Dig | Places ROCK in a 3-cell-thick line, 12 long, perpendicular to the aim, centred `WALL_REACH` (10) cells along the aim from the chest. Only into Empty, gas or liquid cells; never over Bedrock, never into any player's hitbox (check `boxes` as `step_projectile` does). |
| 10 | **Lava Flask** | deep pickup | lobbed | On impact, fills up to about 60 Empty cells **below and around** the impact with LAVA ("Sea of Lava"). |
| 11 | **Black Hole** | deep pickup | slow projectile, no gravity, about 1.5 cells/tick, lifetime about 150 ticks | Each tick, it clears a radius-3 disc of solids (Rock, Dirt, Sand, Wood, plants, Coal, Ice, Glass; not Bedrock, not liquids or gas) where it is, so it bores a tunnel. Each tick, every alive player within 20 cells is pulled one step toward it (a small knock toward the centre through the existing knock path). It passes through terrain instead of stopping on impact, and expires at the end of its lifetime. |
| 12 | **Teleport** *(optional, last)* | deep pickup | fast bolt | On impact, moves the caster to the last empty, body-sized spot along the bolt's path. **Only if** the server's Pos validation can accept it cleanly (read `shared/avatar.ts` `maxPosJump` and D-067/D-078 on respawn and life baselines). If accepting it would mean loosening validation in a way you can't justify, skip it and write up why. |

**Tuning starts** (all in `tuning.rs`): cooldowns Acid 25, Oil 20, Wall 45, Lava 60, Black Hole 120,
Teleport 90. Pickup charges Acid 8, Oil 10, Wall 10, Lava 4, Black Hole 2, Teleport 4. Speeds and gravity: the
flasks reuse Water's (768, 10); Black Hole 384 with 0 gravity; Teleport 1280 with 0 gravity. No player damage
from the spells themselves. The damage comes from the materials (acid and lava already hurt).

**Bounded work:** every burst caps its cells (the `WATER_BURST_CELLS` pattern). Wall writes at most 3x12
cells. Black Hole's per-tick dig is at most (2*3+1)^2 cells and its pull loops over players only. Cap Black
Holes alive per player at 2. Every clamp lives inside the function that does the work.

## Pickups by depth: the "go deeper" reward

`Sim::new` assigns pickup spells by band (`sim/src/sim.rs:74`): shallow gives Water or Rose, deep gives Fire
or Bomb. Change this to a per-band **table** in `tuning.rs`, chosen by counter-based rng:

- **Shallow:** Water, Rose, Acid Flask, Oil Flask, Wall.
- **Deep:** Fire, Bomb, Lava Flask, Black Hole (and Teleport if built).

Weight them so the deep spells feel rare: Black Hole and Teleport at about half the weight of the others.
Keep pickup counts per band unchanged.

**Bags:** `BAG_SPELLS` is 4 and assumes the finite spells are ids 2-5 (`charges[2 + k]`). It now has to cover
every finite spell. Generalise it: map bag index to spell id through a table, or carry every finite spell.
Check the bag pickup and merge code, and `drop_bag`. This changes `BAG_BYTES`, so it's part of the snapshot
bump. Flag the choice.

## Everything that grows with `NUM_SPELLS` (7 to 12 or 13)

Follow F1's trail:

- **The tuning arrays:** `START_CHARGES`, `PICKUP_CHARGES`, `SPELL_ENABLED`, `COOLDOWN`, `SPEED`, `GRAVITY_Q8`.
- **`PLAYER_BYTES`** and the server's `PLAYER_RECORD` (`server/world.ts`, derived from `NUM_SPELLS`; check it still is).
- **The HUD view**, `shared/sim.ts` `NUM_SPELLS`, and `shared/names.ts` `SPELL_NAMES`.
- **`client/spells.ts`:** colours, and the `BAR` slot map; plus `shared/stats.ts` spell keys and `tests/net/spells-table.test.ts`.
- **Cause codes:** these start at 32, so ids up to 31 are safe. Check every `cause < NUM_SPELLS` reader still makes sense.
- **Snapshot:** `FORMAT_VERSION` goes 5 to 6.
- **`tools/inputgen.ts`:** the fuzzed determinism scripts should cast the new spells too.

## Client

- **Spell bar:** 13 slots no longer fit keys 1-9. Keep keys 1-9 for the first nine slots and add `0`, `-`
  and `=` for the next ones, or let the mouse wheel cycle the selection. **Check first that `-` and `=`
  aren't already zoom keys** (they are: `client/room.ts` around line 431). Pick something that doesn't
  clash, for example the mouse wheel plus `Q`/`E` to cycle. Empty slots (0 charges) already dim. The bar
  must still fit at 1280 px and wrap or scroll on a phone.
- **Fx for each spell** in `client/worker.ts` `spellFx`: an impact burst coloured by material for the
  flasks, a dust line for Wall, a dark swirling orb with an inward-particle pull for Black Hole, a flash at
  both ends for Teleport. Sounds go in `client/sfx.ts`, in the existing style: glass smash plus fizz for
  the flasks, a stone thunk for Wall, a low rumble or whoosh loop for Black Hole, a zap for Teleport.
- **The cast ghost:** lobbed spells already predict a flight path. Make sure Wall (instant) and Black Hole
  (slow, no gravity) predict correctly or not at all, without misleading the player.

## Tests (each red first)

- A sim test per spell: the flask fills the right material, capped; Wall doesn't overwrite Bedrock or a
  player; Black Hole bores a tunnel, pulls a player, expires, and respects its cap.
- **Bounded work:** casting every spell at the caps in one tick stays within bounds. Count cells written,
  not wall-clock time.
- **Pickup table:** deep spots only ever give deep spells, shallow spots only shallow, and the weights roughly
  hold over seeds 1-8.
- **Bags** round-trip every finite spell.
- **Snapshot round trip** with a Black Hole in flight.
- **D7:** sleeping is invisible with a Black Hole boring through a sleeping region.
- **D2:** cross-engine hashes agree (the determinism suite).

## Files you may touch

`sim/src/{tuning,spells,entities,sim,snapshot,grid,rng}.rs`, `sim/tests/*.rs`,
`shared/{sim,names,stats,achievements}.ts`, `server/world.ts` (only the derived record length), `client/{spells,
worker,fx,sfx,room}.ts`, `client/index.html` (the spell bar CSS), `tools/inputgen*.ts`, `tests/net/*.test.ts`,
`tests/determinism/*` (update expectations only, never weaken a check), `docs/art/shots/`, and your report.
Don't edit `FUTURE.md`, `docs/DECISIONS.md` or `docs/engineering-decisions.md`.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && git commit ...
```

Run `pnpm test:net` (about 5 minutes) before the client commit and the last commit. **Finish each edit before
starting its gate.** Editing while a gate runs merged two commits in the last two slices.

## Look at it

`pnpm dev:client` serves on 5173 (read the "Local:" line). Open `/game?world=game&avatar=1`. To get charges,
use the dev hooks in `client/room.ts`: `__devGoto(spell)` walks to a pickup. If there isn't a hook that grants
charges, add a **dev-only** one guarded by `import.meta.env.DEV`, the way `__devPaint` is. Use
`agent-browser` via `zsh -ic`, with the viewport at 1280x800 first. Cast each spell and save a screenshot
to `docs/art/shots/f3-<spell>.png`. **Look at each screenshot yourself before citing it.** Kill vite by PID.

## Commit checklist (commit each separately)

- [ ] 1. `NUM_SPELLS` 13 scaffolding: the tuning arrays, the names, the bag generalisation, snapshot format 6, the server record length. Spells enabled but no effects yet, or disabled through `SPELL_ENABLED` until each lands.
- [ ] 2. Acid Flask and Oil Flask (shared burst code), with tests.
- [ ] 3. Lava Flask, with tests.
- [ ] 4. Wall, with tests.
- [ ] 5. Black Hole, with tests, D7 and the snapshot round trip.
- [ ] 6. Pickup table by band, and the tests for it.
- [ ] 7. Client: the bar (selection beyond 9), fx, sounds, the ghost, and the dev charge hook.
- [ ] 8. Teleport (optional; skip with a written reason if validation makes it unsafe).
- [ ] 9. Screenshots and the report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f3-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, how you verified it, and the red-first evidence;
- the bounded-work numbers;
- what you couldn't verify;
- **"Architectural decisions for review"**: the bag representation, the bar's selection scheme, the pickup
  weights, how Black Hole's pull reuses the knock path, and Teleport's interaction with Pos validation. For
  each: what you chose, the alternatives, why, and what it costs later. When unsure about something hard to
  reverse, take the more reversible option and flag it;
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Read `git diff <base>..HEAD -- sim shared server client` cold. Check:

- that every new `NUM_SPELLS`-sized layout agrees between Rust, TS and the server;
- that work is bounded per spell and per tick;
- that Black Hole is sleep-invisible and stays inside the active region (could it bore into a frozen chunk?);
- that the bag generalisation round-trips;
- that the pickup table is deterministic;
- that Teleport can't be abused to skip the server's Pos validation.

Write the findings to `docs/research/review-f3.md`.
