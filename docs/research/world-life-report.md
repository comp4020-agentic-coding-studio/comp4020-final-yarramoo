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
