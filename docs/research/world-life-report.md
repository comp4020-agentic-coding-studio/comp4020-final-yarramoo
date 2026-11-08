# World life: more green, passive creatures, small touches (Opus lead report)

Brief: `docs/briefs/world-life.md`. Branch `world-life` in `/tmp/wt-life`, from `multa` 0760cec. Cap $30.
**B0 = $160.07** (week spend at start). Dispatch stops at $184.07, hand-back by $190.07.

## 1. Investigation (about $3.5)

What exists:
- The surface is a strip of Dirt with bare Wood trees (`place_trees`, `sim/src/gen.rs`): trunk 2 wide, 14-29 tall,
  two short branches, no leaves. The only green is the rock shader's wet-rock tint and the deep grotto's Moss.
- `STEM` with `aux == 0` is already a static, flammable, green, never-growing plant cell (`update_stem` returns at
  once), and `FLOWER` is static too. So leaves, shrubs and flowers need **no new material and no new cell rule**:
  generation alone can place them, and chunk sleeping cannot see them (nothing acts).
- Plants are excluded from the backdrop ground line (`client/background.ts` `PLANTS`), and from `spawn_point`'s
  ground set, so canopies do not move the sky line or the spawn.
- Enemies: kinds 0-7, `MAX_ENEMIES` 64 and a size-L Survival world already places exactly 64, the stepping budget is
  24 per tick lowest ids first (boss first), a round is won only by `boss_killed`, so a non-hostile kind cannot block a
  round. Kills feed `server/achievements.ts` (`slime_slayer`, `exterminator`, `kills_k<kind>`), heals drop from any
  kill 1 in N. Mirrors: `shared/sim.ts` `NUM_ENEMY_KINDS`, `client/worker.ts` + `client/hover.ts` `ENEMY_MAX_HP`,
  `client/toasts.ts` `ENEMY_NAMES`, `client/fx.ts` `pushEnemy`, `shared/stats.ts` `isBossKind`.
- The client has a cosmetic particle system (`client/fx.ts` `Particles`, xorshift, 600 cap shared with spells) and
  a cell shader (`client/render.ts`) that already tints wet rock green as a pure function of the cell and neighbours.

## 2. Plan

Three slices, one worker at a time, in order of what the user asked for:

| # | Slice | Model, cap | Sim change? |
|---|---|---|---|
| W1 | **Surface greenery at generation**: leaf canopies on every tree, shrubs with flowers, wildflower patches (all `STEM` aux 0 / `FLOWER`, only into Empty, out of the spawn columns). Format 16 -> 17 (new generation). | Sonnet, $7 | gen only |
| W2 | **Rabbits: a passive sim enemy kind 8.** No contact damage, flees players, idles with short hops, dies to spells and hazards, no heal drop, no kill stats or achievements, never blocks a round. Placed on the surface, highest ids (so hostile enemies keep the stepping budget). `MAX_ENEMIES` raised to fit. | Sonnet, $8 | yes |
| W3 | **Client touches**: shader grass on exposed surface Dirt (green top cells and swaying blades drawn in the Empty cell above, near the generated ground line only), and a bounded ambient layer: falling leaves under canopies, butterflies by flowers by day, fireflies at night and in the grotto, drips from cave ceilings. Own particle pool so spells never lose particles. | Sonnet, $5 | none |

Choices and why:
- **Grass is a shader effect, not a material.** A Grass material would need a spreading rule (sleep-invisibility
  risk), every mirror, spawn/floor/seed rules taught a new ground id (`spawn_point` only accepts Dirt/Rock/Sand/
  Pebbles/Bedrock), and a meadow that a single Fire spell burns end to end. Drawn grass is a pure function of the
  current grid, so dug dirt loses it and nothing can desync. Cost: grass does not burn. Flagged for review.
- **Passive creatures are sim entities (rabbits), not decoration.** The user asked for mobs; a sim critter is world
  state every player sees in the same place, can be shot, burns in fire and flees the nearest player. It reuses
  the slime's integer hop and body code, so it is the cheapest honest version. The client-only butterflies,
  fireflies and leaves in W3 are honestly decoration (render-only, never read back) and are labelled so.
- **Cut** (cost or risk over value at $30): hills, mountain and the surface lake from `biomes-surface.md` (they
  move the heightfield under traversal and the arena tests: a whole slice of their own); sand traps; hanging vines
  (a solid Stem strand blocks a 5-wide avatar in a passage); a spreading Grass material (above); flying critters and
  cave bats as sim kinds (one passive kind first); ambient sound.

Order rationale: W1 is the biggest visible change and the safest sim change; W2 is the riskiest and the user's
second ask; W3 has no sim risk and can be cut down to the grass shader (a few lines the lead can do) if the budget
runs short.

## 3. W1: surface greenery (Sonnet, about $4.1)

Built by the worker (`c4b0f48`, report `docs/research/life-w1-report.md` `04a9e9c`): `canopy()` crowns on every trunk
top and branch tip, `place_greenery()` shrubs and clustered wildflower tufts, all `STEM`/`FLOWER` aux 0, written only
into Empty cells, clear of the spawn columns, bounded tries; salts 278-284; format 16 -> 17; `sim/tests/greenery.rs`
(5 tests, three shown red by the worker: canopy loop skipped, aux 1, spawn-column check removed).

Lead review: the diff is generation-only, integer, bounded, no new cell rule, so chunk sleeping cannot see it. The
first look at seed 7 (M, day) read as small flat "lollipops" and the tufts barely showed, so the lead tuned it
(crowns rx 7-10, ry = 3/4 rx, branch tips 3-5, tufts 520 at L) and re-recorded the pins on purpose (golden-v17,
`SCRIPTED_HASH`, perf trace, boss_gen non-survival hashes).

Gate on `e7a2a24` (W1 + tuning): cargo `--no-fail-fast`, clippy, typecheck, determinism 53/53 (11 files), net
451 passed + 1 skipped (63 files); logs `/tmp/life-g-{cargo,clippy,tsc,det,net}.log`. The first gate run was red:
`gen::tests::borders_surface_and_open_fraction` measured the "surface" as the first non-Empty cell, so the bigger
crowns counted as 167 off-band columns; it now skips `STEM`/`FLOWER` (the 120-column guard is unchanged).

## 4. Budget decision: rabbits (W2) cut

After W1, the gate and the tuning, week spend was $180.15 (B0 + $20.1), $4 short of the dispatch stop. W2 was capped
at $8 and needs a gate and a look on top; it would breach the $30 cap. **Cut**, brief kept ready at
`docs/briefs/life-w2-rabbits.md` (kind 8, flee AI, lobby stepping, no heal/achievement, `MAX_ENEMIES` 80). W3 goes
ahead at a $3.5 cap because it is client-only (no gate beyond typecheck and the net suite) and its butterflies and
fireflies give the world some moving life, labelled as decoration.

## 5. W3: grass shader and ambient layer (Sonnet, about $0.8)

`2befe42` grass in `client/render.ts` (exposed Dirt within 6 rows of the generated ground line greens; 1-2 cell blades
over sky, sway gated on reduced motion; guard test in `tests/net/background.test.ts`). `fec8513` `client/ambient.ts`:
its own 120-particle pool (spells keep all 600 of theirs), bounded sampling in the camera view only: falling leaves
under crowns, butterflies by flowers (day/dawn), fireflies at night/aurora and near Moss/Mushroom, cave drips that stop
at solids; nothing under reduced motion. `tests/net/ambient.test.ts` (cap, view, reduced motion, sky gate, drip);
the cap test was green under mutation at first (fixture never filled the pool), so the worker added a dense fixture
that went red. The view-rectangle test was not shown red (weak, flagged). Review: render-only, reads the mat view and
the captured ground line, writes only `rects`; no sim, shared or server change.

Lead check: `pnpm typecheck` and `pnpm test:net` 457 passed + 1 skipped (64 files), logs `/tmp/life-g3-{tsc,net}.log`.

## 6. Results

**Built**: leafy crowns with blossoms on every surface tree, shrubs and wildflower meadows (generation, format 17);
grass on exposed surface dirt with blades; an ambient layer of leaves, butterflies, fireflies and drips.
**Passive creatures**: only as decoration (butterflies, fireflies), **not** as sim entities: the rabbit slice
(a passive sim enemy kind) was cut for budget; its brief is ready (`docs/briefs/life-w2-rabbits.md`).
**Cut**: rabbits (budget), hills/mountain/lake/sand traps (own slice, traversal risk), vines (block passages),
a spreading Grass material (sleep risk, mirrors, burns the meadow), bats/birds as sim kinds, ambient sound.

Screenshots (all Read): `shots/life-before-{surface-s7,cave-s7,menu}.png`, `shots/life-w1-{surface-s7,zoom-s7,menu,dump-s3-L}.png`,
`shots/life-w3-surface-s7-day.png`, `shots/life-after-{surface-s7-day,surface-s7-night,cave-s3-M}.png`. Seeds 7 (M) and 3 (M in browser, L in
`dump_world`). The menu backdrop (seed 220, M) shows crowns and the flower line. Note: the vite dev route loads
`sim-dev.wasm`, which needs `pnpm build:sim:devpaint` after a sim change or it shows the old generation.

Gates: W1+tuning full gate green on `e7a2a24` (`/tmp/life-g-*.log`: determinism 53/53, net 451+1 skipped);
W3 typecheck + net green (`/tmp/life-g3-*.log`). The full gate was **not** re-run after W3 (no sim change); the
session model should run it once before merging.

**Spend**: B0 $160.07. Lead investigation, briefs, review, tuning, two gates and screenshots about $17.3; W1 about $4.1; W3
about $0.8. Total about $22.1 (end $182.18).

## Architectural decisions for review
1. **Greenery is generation-only, reusing `STEM` aux 0 and `FLOWER`** (no new material, no cell rule). Alternatives:
   a Leaf/Grass material with its own rule. Why: zero sleep-invisibility risk and no mirrors. Cost: leaves are
   indistinguishable from grown stems (they burn the same; hover says "Stem"), and changing them later is another
   format bump.
2. **Format 16 -> 17** for the new generation (no layout change), golden fixture renamed to `golden-v17.bin`.
3. **`CANOPY_CLEAR` 12 rows** keeps crowns above head height; short trees get clipped crowns. `SPAWN_CLEAR_COLS`
   duplicates `spawn_point`'s scan arithmetic in `gen.rs`: change both together.
4. **`borders_surface_and_open_fraction` measures the terrain top past `STEM`/`FLOWER`**: the test's intent is
   terrain height; its 120-column guard is unchanged.
5. **Grass is a shader effect**, not cells: a pure function of the current grid and the generated ground line, so it
   cannot desync and vanishes when the dirt is dug; it does not burn. Reversible (delete one branch).
6. **Ambient has its own pool** (cap 120) beside `Particles`; `Math.random`, render-only (invariants 1, 9).
7. **Passive mobs not built.** The rabbit brief puts them at kind 8, ids below the boss, `MAX_ENEMIES` 80, lobby
   stepping for passive kinds only, no heal/achievements: review that design before it is built.

## D-row draft
| D-2xx | 2026-11-07 | **The surface is green at generation**: every tree gets a leaf crown (`STEM` aux 0, 1 in 25 a blossom),
shrubs and wildflower meadows on flat Dirt outside the spawn columns (`place_greenery`, salts 278-284); format 17.
Grass on exposed surface dirt and an ambient layer (leaves, butterflies, fireflies, drips) are client-only cosmetics.
Passive sim creatures (rabbits) are briefed but cut for budget. | world-life report |

## engineering-decisions entry draft
**Making the world feel alive without new simulation rules (7 Nov).** The user asked for more green and non-hostile
mobs. Every new cell rule must keep chunk sleeping invisible, and every new enemy kind touches nine mirrors and a full
enemy budget, so the lead chose the cheapest honest versions: generation places leaves and flowers using cells that
already exist and never act (`STEM` aux 0, `FLOWER`), and everything that moves (grass sway, leaves, butterflies,
fireflies, drips) is drawn by the client from the grid and never read back. The one real sim creature, a fleeing
rabbit, was designed and briefed but cut when the $30 cap came close; it waits on review of its id and lobby rules.
A generator test that measured "surface" as the first non-Empty cell went red on the bigger crowns and was corrected
to measure terrain. (D-2xx; `docs/research/world-life-report.md`; commits c4b0f48, e7a2a24, 2befe42, fec8513.)

## FUTURE.md ideas (listed, not added)
- Rabbits as a passive sim kind (brief ready). Birds that take off when a player nears a tree (same pattern, a flier).
- Tuft density by surface length, not area (W1). Bigger crowns for tall trees (W1).
- A Leaf material name so hover says "Leaves", not "Stem" (format bump).
- Fireflies are faint on screen at night; brighter or bigger glows (lead's look).
