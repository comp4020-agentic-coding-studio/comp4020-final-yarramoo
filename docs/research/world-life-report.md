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
