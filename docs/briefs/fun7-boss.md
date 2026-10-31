# Brief F6: the boss (the Deep Mage) and the Survival win

**Why:** Survival is a co-op descent, and killing the boss wins (D-158). F4 (D-162) and F5 (D-163) built the
enemies and the loss path. Nothing can win yet: `round_won()` in `sim/src/sim.rs` returns `false`. This slice
adds the arena, the boss and the win, from `docs/research/enemies-design.md` section 5 ("Boss"). Read that
section, section 11 and the decisions banner at the top of the file.

Out of scope: the ready-up lobby (D-166, the next slice), achievements and server claims (F7), and Deathmatch.
Don't touch D-161's late-join rule.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 120 tool calls. Read `CLAUDE.md`
first. The sim invariants and harness rules are binding:
- no floats;
- counter-based rng, with a new salt per use;
- bounded work;
- chunk sleeping must be invisible;
- `rm` only on literal absolute paths;
- every commit gated on exit codes chained with `&&`;
- every new test shown red first;
- no pushing;
- finish each edit before starting its gate;
- never weaken a test expectation.

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`. Read `docs/research/f5-worker-report.md`,
`docs/research/review-f5.md` and `sim/src/enemy.rs` first. Build on the existing `ENEMY_STATS`, stepping rule,
flier movement (the imp's), `damage_enemy`, hazard scan, enemy-owned projectiles (`ENEMY_OWNER`,
`MAX_ENEMY_PROJECTILES`) and enemy-owned `explode_at`. Don't fork them.

## 1. The arena (`sim/src/gen.rs`)

- Add a new `carve_arena`, called beside `carve_chambers`, **only in worlds with enemies on** (Survival).
  Other cave worlds keep their terrain byte for byte. Add a test that a non-Survival seed's grid is
  unchanged.
- The arena is one large ellipse, about rx 70 and ry 40 at size L, scaled by `Scale`. Centre it on a **path
  point** in the deep band, between `deep_top` and `repair_depth - 40`, clear of the border (`near_border`).
  That way it joins the traversal network.
- Flatten the floor, add 2-3 rock pillars for cover, and put no liquids inside. Liquids placed later must
  not land inside the arena either; check the order of the gen passes.
- Keep normal enemies and gas or lava pockets out of the arena and out of a margin around it.
- Put a **supply pile** just outside the arena, on the path side: a few pickups of the deep spells (design
  item a). Without one, a party arriving with spent charges can't win. Size it from the balance numbers
  below.
- `traversable_to_every_band` must stay green. Add a test that the arena centre is reachable from the
  spawn, for seeds 1-8 at sizes S, M and L.

## 2. The boss (`sim/src/enemy.rs`, `tuning.rs`)

**Kind and stats.**
- Kind 4 is `ENEMY_BOSS`. `NUM_ENEMY_KINDS` becomes 5.
- Starting values: hp 1200 (`hp` is already `u16`), a hitbox of about 11 x 14 cells, and contact damage 20
  with a shove.
- Immune to Fire and Lava, because it makes the lava ring.

**Placement and ids.**
- Place exactly one boss per Survival world, at the arena centre.
- **It must never be starved by `MAX_ENEMIES_STEPPED`**, which steps the lowest ids first. Either place it
  so its id is lowest, or step it unconditionally when it's in range. Pick one and flag it.

**Movement.**
- A flier, reusing the imp's movement. It hovers over the arena floor and drifts toward the nearest player.
- It is **leashed to the arena ellipse** and never leaves it.
- It doesn't heal while frozen (design section 11 item 10: no healing).

**Phases.** The phase is derived from hp thresholds and stored in state. It is hashed.

1. **100-66%**:
   - a Fire bolt at the nearest player in line of sight every 60 ticks, using the imp's enemy-owned bolt
     path;
   - a contact shove.
2. **66-33%**:
   - adds a Bomb lob every 120 ticks: the existing `BOMB` spell, enemy-owned, so it hurts players only;
   - **summons Fire imps**, at most 4 summoned alive, into rng-chosen EMPTY cells inside the arena.
3. **Below 33%**:
   - enraged: speed x1.5;
   - a fan of 3 bolts every 90 ticks;
   - a **lava ring**: 24 LAVA cells in an arc on the arena floor, written via `Grid::set` (bounded), at most
     once per N ticks.

Each phase change emits a new `EV_ENEMY_PHASE` (a = enemy id, b = phase).

**Summons need ids.** Enemies have no id counter today; ids come from placement order. A summoned imp needs
a fresh id that keeps `enemies` sorted and can't repeat after a death (for example the max id ever plus 1,
which needs a counter in state). Choose the scheme, keep it hashed and snapshotted, and flag it. The total
must stay within `MAX_ENEMIES` (64; L places 51 today, plus the boss, plus 4 summons). Show the arithmetic in
a test.

Don't add spell ids or grow `NUM_SPELLS`; reuse `FIRE_BOLT` and `BOMB`. The enemy-bolt cap
(`MAX_ENEMY_PROJECTILES` 16) applies to the boss too. A 3-bolt fan at the cap fires what fits.

## 3. The win (`sim/src/sim.rs`)

- `round_won()` is true once the boss is dead. Prefer deriving it from state that already exists, such as
  "this Survival world has a boss and none is left in `enemies`", over adding a hashed byte. If you need
  one, flag it.
- The existing `check_round_end` then fires `EV_ROUND_END { a: 1 }` and sets `round_result = 1`. **A tick
  where the boss dies and the last player also dies:** decide which wins, test it, and flag it. The
  recommendation is that the win counts.
- The boss's death emits `EV_ENEMY_DEATH`, with kill credit as usual.

## 4. Balance (measure; don't guess)

1200 hp is the design's number. Measure the charges a party actually holds:
- how many charges a player picks up on a typical descent of seed 1 at size M (count the pickups on the path
  bands);
- the damage per charge of each spell against the boss.

Then set the boss hp and the supply pile so **one well-supplied player can just win and two players win
comfortably**. Put the arithmetic in the report, and keep every number in `tuning.rs`.

## 5. Bounded work

- The lava ring is at most 24 writes per firing.
- Summons are at most 4 alive and bounded per tick.
- The volley is capped by the enemy-bolt cap.
- The arena carve is a fixed-size ellipse.
- The boss's line of sight reuses the imp's capped DDA and cadence.
- Extend the enemy work-count test to the boss in phase 3 with summons alive. Make it bite: halve the bound
  and show it fails.

## 6. Client

- **Boss sprite**, about 24 x 24, in `client/fx.ts` style: a robed mage with a glowing staff. Tint it per
  phase, and give it a hurt flash.
- **Boss HUD bar:** a wide bar at the bottom of the screen with the name "The Deep Mage", shown while the boss
  is in the entities view. It is fed from the entity's hp.
- **A depth hint** for finding the boss: a small HUD line such as "The Deep Mage: 340 m below". This is
  optional: the arena centre is deterministic from the seed, so the client may compute or read it. Don't add
  sim state just for this.
- **Sounds** (`client/sfx.ts`): a roar on each phase change, the boss cast, and a big death sound.
- **Banner:** check that "Victory" (`client/room.ts:730`) shows on a win, including for a client that
  reconnects after it.
- **Toasts** (`client/toasts.ts`): "was struck down by the Deep Mage".
- **Dev routes:** make `__devGotoEnemy(4)` put the player **at the boss's height, inside the arena, in open
  air**. Also add `__devBossHp(n)`, a dev-only helper that sets the boss's hp for the screenshot of the
  phases (dev route only, through the same dev path as the existing dev helpers, never reachable in a real
  room).

## Tests (each red first)

**Real terrain** (as F4 learned): at least these on seed 1's real generated Survival world, not only a
synthetic box.

- **Gen:**
  - the arena exists in every Survival world (seeds 1-8, S/M/L) and in no other world;
  - it has no liquids;
  - it is reachable;
  - normal enemies stay out;
  - the supply pile is outside the arena.
- **Phases:**
  - each threshold switches the phase exactly once and emits one `EV_ENEMY_PHASE`;
  - phase 2 summons imps, capped;
  - phase 3 places the ring and fires the fan, both capped.
- **The leash:** knocked hard, the boss stays inside the arena.
- **The win, end to end:**
  - a scripted player kills the boss with real spell inputs on seed 1;
  - `EV_ROUND_END { a: 1 }` fires once and `round_result == 1`;
  - enemies stop afterwards;
  - also the same-tick win-and-death case.
- **No starving:** with 24 other enemies in range, the boss still steps.
- **Summon ids:**
  - they stay sorted and unique across the death and resummon of a summon;
  - the snapshot round trip keeps them.
- **D7:** sleeping is invisible in a boss fight, through all three phases.
- **D5:** a snapshot mid phase 3, with the ring, summons and bolts in flight.
- **D2:** cross-engine. Extend the Survival determinism script so the boss reaches phase 3, or dies.
- **Hostile snapshots:** decoding rejects an out-of-range kind, phase or summon counter.

## Files you may touch

- Sim:
  - `sim/src/{enemy,entities,sim,spells,snapshot,tuning,rng,gen,grid,config}.rs`;
  - `sim/tests/*.rs`.
- Shared and client:
  - `shared/{sim,names}.ts`;
  - `client/{worker,fx,sfx,toasts,room,render,main}.ts`;
  - `client/index.html`, only for the HUD element.
- Tools and tests:
  - `tools/inputgen*.ts`;
  - `tests/net/*.test.ts`;
  - `tests/determinism/*`: update expectations only, never weaken a check, and tie any re-pointed
    expectation to the exact tick it is about.
- Output: `docs/art/shots/` and your report.

Don't edit `FUTURE.md`, `docs/DECISIONS.md` or `docs/engineering-decisions.md`.

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && git commit ...
```

**Run `pnpm test:net` before the win commit, the client commit and the last commit.** F4 left 2 net tests red
because the worker skipped it. A test that fails once and passes on retry is a defect: find the
timing-dependent assertion. A snapshot format bump has consequences in `server/db.ts`'s label and in net
tests (`entity-layout`, `room-abi`); follow them through.

## Look at it

- `pnpm dev:client` serves on 5173. Open `/game?world=game&avatar=1&cfg=survival`.
- Before you call anything broken, compare `__devMe()` against the boss's position: the camera may not be
  where you think (D-162).
- Use `agent-browser` via `zsh -ic`, with the viewport at 1280x800 first. Screenshot:
  - the arena;
  - the boss in each phase (use `__devBossHp`);
  - the HUD bar;
  - the Victory banner.
- **Look at each screenshot yourself before citing it.**
- Kill vite by PID and run `agent-browser close` at the end.

## Commit checklist (commit each separately)

- [ ] 1. Arena: `carve_arena` (Survival only), the supply pile, gen tests (reachability S/M/L seeds 1-8, no liquids, non-Survival unchanged).
- [ ] 2. Boss kind: stats, placement, stepping priority, flier movement with the leash, phase 1 attacks, tests.
- [ ] 3. Phases 2 and 3: bombs, summons and their id scheme, the fan, the lava ring, `EV_ENEMY_PHASE`, the bounded-work test.
- [ ] 4. The win: `round_won`, the same-tick rule, the end-to-end kill on seed 1, D5, D7, D2. Run `pnpm test:net`.
- [ ] 5. Balance numbers from section 4, in `tuning.rs`, with the arithmetic in the report.
- [ ] 6. Client: sprite, HUD bar, depth hint (optional), sounds, toast, dev routes. Run `pnpm test:net`.
- [ ] 7. Screenshots and the report. Run `pnpm test:net`.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/f6-worker-report.md` as you go. It should cover:

- per commit: the hash, what changed, how you verified it, and the red-first evidence;
- the arena size per size class;
- the enemy count arithmetic;
- the work-count maxima;
- the balance arithmetic;
- what you couldn't verify;
- **"Architectural decisions for review":**
  - the arena only in Survival;
  - the boss's stepping priority;
  - the summon id scheme and any new state;
  - how `round_won` is derived;
  - the same-tick win-and-loss rule;
  - any snapshot format bump;
  - the leash;
  - the dev `__devBossHp` path.

  For each: what you chose, the alternatives, why, and what it costs later slices (the lobby, achievements,
  Deathmatch).
- FUTURE.md ideas, suggested only.

## Independent review (separate Sonnet reviewer, after the worker)

Read the diff cold. Check:

- that the arena can't break `traversable_to_every_band` or leave a path blocked, at every size;
- that non-Survival worlds are unchanged;
- that summon ids can't collide or unsort, including after a snapshot;
- that work is bounded (ring, summons, fan);
- that D7 holds;
- that the win is derived from hashed state, and that a reconnecting client sees it;
- that `__devBossHp` can't be reached outside the dev route;
- that the snapshot decode is hostile-safe.

Write the findings to `docs/research/review-f6.md`.
