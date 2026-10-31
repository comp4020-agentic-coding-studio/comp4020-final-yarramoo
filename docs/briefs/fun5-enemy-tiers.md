# Brief F5: enemies slice 2: Fire imp, Acid slime, Burrower worm

**Why:** F4 (D-162) built the enemy foundation and the Slime. This slice adds the next tiers from
`docs/research/enemies-design.md` section 5 (read sections 5-6 and the decisions banner), so the descent gets
harder as you go deeper. Survival only, one-shot placement, co-op (D-157, D-158, D-160).

**Worker:** one Sonnet worker. Use no subagents, and stay within about 110 tool calls. Read `CLAUDE.md`
first: the sim invariants and harness rules are binding (no floats, counter-based rng with a new salt per
use, bounded work, chunk sleeping invisible, `rm` only on literal absolute paths, every commit gated on exit
codes chained with `&&`, every new test red first, no pushing, finish each edit before starting its gate,
never weaken a test expectation). Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Read
`docs/research/f4-worker-report.md` and `sim/src/enemy.rs` first: build on F4's `ENEMY_STATS`, stepping rule,
movement, `damage_enemy`, hazard scan and immunity bitmask. Don't fork them.

## The three new kinds

| kind | band | hp | movement | attack | immune | weak |
|---|---|---|---|---|---|---|
| 1 **Fire imp** | shallow, lower half, plus deep top | 30 | **flier**: no gravity, drifts toward the target, keeps about 40-60 cells away, bobs | a Fire bolt every 90 ticks when it has line of sight within 120 cells, reusing the projectile list and the existing `FIRE_BOLT` spell | Fire, Lava | Water: 1 hp every 4 ticks in water |
| 2 **Acid slime** | deep | 60 | walker, like the Slime but slower | contact 15; drops 1 ACID cell under itself every 20 ticks while hunting (cap 1 cell per tick); bursts into about 12 ACID cells on death (capped) | Acid | Fire |
| 3 **Burrower worm** | deep, lower half | 90 | dormant inside rock until a player is within 40 cells, then **tunnels** toward the target, digging a radius-3 disc each step through `Grid::dig`-style removal (cap the cells per tick), slower inside rock | contact 20 when it reaches open space next to a player | none | Lava, Fire |

Numbers are starting values in `tuning.rs`; take them from the design table.

### Enemy projectiles (design section 11, item 4: reuse the projectile list)

The imp's Fire bolt goes into the existing `projectiles` list. Mark enemy ownership with the design's scheme:
the high bit of `owner` set, plus the enemy id. Then:

- An enemy bolt **hurts players** (`apply_damage` with a new enemy cause, 40 + kind, so `damage_from_env()`
  gates it, like contact). It never hurts enemies, and it never credits a player as killer.
- Player-owned projectiles keep their F4 behaviour against enemies.
- Check every reader of `q.owner`:
  - `hit_player` credit;
  - `explode_at`;
  - owner grace;
  - the per-player projectile cap (`MAX_PROJECTILES_PER_PLAYER` must not count enemy bolts against a
    player);
  - the snapshot;
  - the client's ghost and `dropGhost` (`q.id === myId`, so enemy bolts must not match a player id);
  - `chestOf`;
  - fx;
  - the Bomb fuse code.

  An enemy-owned id must never collide with a real player id. Also cap enemy bolts in flight (for example 16
  in total).

### Line of sight

The imp only fires with a clear line: an integer DDA from imp to target over cells, stopping at the first
solid cell, with a bounded step count (about 120). Fliers don't need ground. They collide with solids the
same way walkers do (box against grid), with no gravity.

### Placement (`sim/src/gen.rs`)

Extend F4's placement by band:

- Slimes stay in the shallow band.
- Imps go in open air in the lower shallow and deep-top bands. They need an empty pocket around them.
- Acid slimes go on deep floors.
- Worms go **inside rock**, deep, at least a few cells from any open cell, so they really are buried until
  they wake.

Count them with `scale_count`. The total stays within `MAX_ENEMIES` (48). If it doesn't fit, raise the cap
deliberately, update the bounded-work reasoning and test, and flag it. Keep enemies off the spawn column and
off pickups. `traversable_to_every_band` stays green. Worms dig, which only adds open space.

### Bounded work

- The worm digs at most (2*3+1)^2 cells per step, and only while awake and stepped.
- The acid trail is capped at 1 cell per tick.
- The death burst is capped.
- Line-of-sight work is capped per imp per tick, and imps only check every N ticks (for example every 15
  ticks, staggered by id).
- Extend F4's work-count test to cover each kind, and make it bite: halve the bound and show it fails.

## Client

- Sprites in `client/fx.ts` style:
  - the imp: a small red-orange winged blob with a flame flicker;
  - the acid slime: a sickly green slime, darker than the Slime, with drips;
  - the worm: a segmented brown or pink head that shows when it breaks out of rock.
- The F4 hp bar applies to all of them.
- Sounds in `client/sfx.ts`:
  - imp: a cast crackle and a screech on death;
  - acid slime: a hiss and a splat;
  - worm: a rumble while tunnelling near the camera (rate-limited) and a crunch on death.
- Death toasts: add per-kind wording in `client/toasts.ts` ("was burned by an imp", "was dissolved by an acid
  slime", "was eaten by a worm"). The cause is 40 + kind.

## Tests (each red first)

- **Per kind:**
  - movement: the imp keeps its distance and flies over a gap, the acid slime walks, and the worm stays
    dormant, then tunnels toward a player;
  - the attack lands;
  - immunities and weaknesses: the imp is hurt in water and not by fire; the acid slime is unhurt by acid;
    the worm is hurt by lava.
- **Enemy bolts:**
  - they hurt players but never enemies or the imp itself;
  - they credit no player;
  - they never count toward a player's projectile cap;
  - an enemy owner id never equals a player id;
  - a bolt survives a snapshot round trip.
- **The acid trail and the death burst** are capped.
- **Line of sight:** blocked by rock, clear in open air.
- **D7:** sleeping is invisible with each kind, and with a worm tunnelling through a sleeping chunk.
- **D5:** a snapshot mid-fight with an imp bolt in flight and a worm mid-tunnel.
- **D2:** cross-engine. Extend the Survival determinism script so an imp fires and a worm digs.
- **Gen:** each kind appears only in Survival, in its band; worms are buried; counts per size.
- **Real terrain** (as F4 learned): at least one test per kind on seed 1's real generated world, not only a
  synthetic box.

## Files you may touch

`sim/src/{enemy,entities,sim,spells,snapshot,tuning,rng,gen,grid,materials}.rs`, `sim/tests/*.rs`,
`shared/{sim,names}.ts`, `client/{worker,fx,sfx,toasts}.ts`, `tools/inputgen*.ts`, `tests/net/*.test.ts`,
`tests/determinism/*` (update expectations only, never weaken a check; tie any re-pointed expectation to the
exact tick it is about), `docs/art/shots/`, and your report. Don't edit `FUTURE.md`, `docs/DECISIONS.md` or
`docs/engineering-decisions.md`.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && git commit ...
```

Run `pnpm test:net` before the client commit and the last commit. A test that fails once and passes on retry
is a defect: find the timing-dependent assertion.

## Look at it

`pnpm dev:client` serves on 5173. Open `/game?world=game&avatar=1&cfg=survival`.
- **`__devGotoEnemy()` drops you onto the floor below the enemy**, often about 100 rows down (D-162). Before
  you call anything broken, read the sim's positions: compare `__devMe()` against the enemy's position.
- Add a kind argument (`__devGotoEnemy(kind)`) and put the player at the enemy's **height**, in open air.
- Use `agent-browser` via `zsh -ic`, with the viewport at 1280x800 first. Screenshot each kind attacking.
- **Look at each screenshot yourself before citing it.**
- Kill vite by PID.

## Commit checklist (commit each separately)

- [ ] 1. Enemy-owned projectiles: the owner scheme, every reader updated, the cap, tests (no new kind yet; a test-only cast is fine).
- [ ] 2. Fire imp: flier movement, line of sight, firing, immunities and weakness, placement, tests.
- [ ] 3. Acid slime: movement, the trail, the death burst, immunity, placement, tests.
- [ ] 4. Burrower worm: dormant, tunnelling, contact, placement inside rock, tests, D7 while tunnelling.
- [ ] 5. Client: sprites, sounds, toasts, the dev goto by kind.
- [ ] 6. Screenshots and the report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f5-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, how you verified it, and the red-first evidence;
- counts per kind per size;
- the work-count maxima per kind;
- what you couldn't verify;
- **"Architectural decisions for review"**: the enemy-owner id scheme, the enemy bolt cap, line-of-sight
  cost and cadence, the flier collision, the worm's digging and whether it can breach liquid pools (flooding
  is fine but say so), and the `MAX_ENEMIES` change if any. For each: what you chose, the alternatives, why,
  and what it costs the boss slice;
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Read the diff cold. Check:

- that the enemy-owner scheme can't collide with player ids, and that every `q.owner` reader is right;
- that enemy bolts never credit a player and never count against player caps;
- that work is bounded (the worm dig, the acid trail, line of sight);
- that D7 holds while tunnelling;
- that worm digging can't break `traversable_to_every_band` assumptions or pickups;
- that the snapshot covers enemy bolts.

Write the findings to `docs/research/review-f5.md`.
