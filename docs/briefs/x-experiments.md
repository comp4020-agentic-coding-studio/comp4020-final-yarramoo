# Brief X: three feature experiments (5 Nov morning)

**Why:** the user asked to spend the last of the week's budget "experimenting with new features": sophisticated
rigid-body falling rock, new bosses and enemies, new spells and materials. These are **experiments on their own
branches. None of them merges this week** without the user playing it first; the deploy candidate is `multa`.
So: be ambitious in what you try, honest in what you report, and leave a branch someone can pick up.

**Every experiment:** one Sonnet worker in its own worktree (already created from `multa` at `85fe187`; run
`pnpm install` there first). **Hard stop at about 50 tool calls, and wrap up by 08:50** (`date` tells you the time):
commit what works, write the report, stop. Rules: `CLAUDE.md`, the 11 simulation invariants above all (integers only
in `sim/`, no floats, no HashMap, counter-based rng, bounded work per input and per tick, hash fixed-width ints only,
sleeping invisible); commits only on a green gate chained with `&&` (never `;`, never through `grep` or `tail`); `rm`
only on literal absolute paths; **no pushing** (the session model pushes the branch); prefix cargo with
`PATH="$HOME/.cargo/bin:$PATH"`. Use no subagents.

**The gate for an experiment** is lighter than for a merge, because it won't merge as is:
`cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. && pnpm typecheck && git commit ...`.
Run `pnpm test:determinism` once at the end if you have time and report the result; don't block on it.
If a snapshot or hash changes, bump `FORMAT_VERSION` and regenerate the golden file (`HF_REGEN=1 cargo test --release
--test golden`) and say so.

**Report:** `docs/research/x-<name>-report.md` in your worktree, committed: what you built, what works and what
doesn't (with test names), what it would take to finish, the risks to determinism and performance, screenshots if
you got to a browser (`docs/art/shots/x-<name>-*.png`), and "Architectural decisions for review". Write the report
**as you go** (a skeleton at the start, filled in after each commit) so a stop at the cap still leaves it.

## E1 bodies: rigid-body falling rock (`/tmp/wt-x-bodies`, branch `x-bodies`, vite port 5190)

Read `docs/research/rigid-bodies.md` (all), `docs/research/review-n4-falling-rock.md`. Build **v1** on top of `multa`
(not on the v0.5 branch; v0.5 is grid-only, this is the entity version): a `Body` entity that lifts a cut-free
island out of the grid, falls as one piece in fixed point (`vx`, `vy`, gravity, DDA sub-steps), and rasterises back
into the grid when it rests. Players and enemies block it (no crush yet). Hashed and snapshotted. If v1 works with
time to spare, try **rotation**: an integer angle (e.g. 256 steps), a fixed-point sin/cos table (a `const` table,
no floats), and rasterising the rotated cells on rest. Say clearly how far you got. A test for: determinism
(snapshot mid-fall, restore, equal hashes every tick), bounded work (cap bodies and cells), and sleep on/off.

## E2 enemies: new enemies and a second boss (`/tmp/wt-x-enemies`, branch `x-enemies`, vite port 5191)

Read `docs/research/enemies-design.md`, `sim/src/enemy.rs`, `sim/src/entities.rs` (Enemy), `tuning.rs` (ENEMY_STATS,
the boss constants), D-157 to D-167 and D-181. Add **two new enemy kinds** that use the falling-sand world, e.g.:
- a **Burrower** that tunnels through dirt and sand (digs cells as it moves, bounded per tick) and surfaces under
  players;
- a **Lava wisp** or **Frost sprite** that leaves its material behind (a capped trail), immune to its own element;
- or something better from the design doc.
And a **second boss** design for a different depth or room size: e.g. a **Sand Colossus** made of the terrain it
walks on (its hp is the sand it carries; digging it apart hurts it), or a **Hive Queen** that spawns from nests.
Build the boss if you can; if not, write its design and a stub. Generator placement in Survival only, as now. The
client needs a sprite for each (`client/worker.ts` `pushBoss`/enemy drawing, `client/hover.ts` names, the death-cause
text in `client/toasts.ts`). Tests: each kind's behaviour, determinism, bounded work.

## E3 spells: new spells and materials (`/tmp/wt-x-spells`, branch `x-spells`, vite port 5192)

Read `docs/research/spells-ideas.md`, `sim/src/spells.rs`, `sim/src/materials.rs`, `sim/src/grid.rs` (the material
rules), D-153, D-156, D-159, D-175. Add **three or four materials** with real interactions, e.g.:
- **Mud** (water + dirt; slows, dries back to dirt);
- **Salt** (melts ice, dissolves in water into brine);
- **Thermite** (burns through rock, ignited by fire);
- **Vines** (grow along walls from seeds, climbable later);
- **Snow** (a light powder that melts near fire or lava, packs into ice under weight).
And **two or three spells** that play with them, e.g. **Freeze** (water to ice in a cone, bounded), **Quake**
(shakes loose a bounded patch so it falls as powder), **Mudslide**, **Teleport** (but read FUTURE.md's Teleport note
about Pos validation first, and skip it if it would weaken the server's check). Wire each into the pickup tables
(`PICKUP_CHARGES`, the band tables), the client's palette and hotbar (`client/materials.ts`, `client/spells.ts`,
`shared/names.ts` `MATERIAL_NAMES` and `MATERIAL_CLASS`, `SPELL_NAMES`) and hover names. Material ids append (22+),
spells append (13+); bump `NUM_SPELLS` and the snapshot format if the player record grows. Tests: each interaction,
each spell, bounded work, determinism.
