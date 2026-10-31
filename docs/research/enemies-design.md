# Enemies: research and design

Status: research only, no code changed. Read from `CLAUDE.md` (invariants), `docs/engineering-decisions.md` entry 8, `sim/src/{entities,sim,spells,grid,snapshot,gen,config,tuning}.rs`, `client/worker.ts`, `client/fx.ts`. Line numbers are at commit 847d305.

## Summary of the recommendation

Enemies are a new sorted-by-id `Vec<Enemy>` in `Sim`, fed by a fixed list of generator-placed **nests** (like `Pickup`: identity regenerated from the seed, only a respawn timer is state). An enemy steps only if it lies inside a small rectangle around an active player, a rule computed from player positions (state), not from the `awake`/`active` chunk flags, so D7 stays true. Everything is integer, uses `rng(seed, tick, x, y, salt)`, and is capped. Enemy projectiles reuse the existing projectile list (owner id with a high bit). The boss is a nest of kind Boss in a carved arena at the bottom of the deep band, with three hp phases. Enabled by a room-config byte taken from the reserved bytes (off in Sandbox and Creative; a new preset or a flag in Caves PvP).

## 1. State

Add `pub enemies: Vec<Enemy>` and `pub nests: Vec<Nest>` to `Sim` (sim.rs:28-45), next to `players`, `pickups`, `projectiles`, `bags`.

Existing storage for comparison: players sorted by id (`entities.rs:9-24`, `PLAYER_BYTES` at :27), pickups by id (:84-92), projectiles and bags in spawn order (:116, :145). Enemies should be **sorted by a monotonically assigned `id: u32`** (counter in `Sim`, hashed), not spawn order, so lookups are `binary_search` as for players and projectile ownership can name them. Removal with `retain` keeps order.

Fields (all fixed-width, little-endian, no `usize`, invariant 7):

| field | type | note |
|---|---|---|
| id | u32 | ever-increasing; `ENEMY_OWNER_BASE | id` goes in `Projectile.owner` |
| kind | u8 | tier/kind index into a const stats table in `tuning.rs` |
| nest | u16 | index of the nest it respawns into (0xFFFF = summoned, no nest) |
| x, y | i32 | 1/16 cell, feet centre/feet line, same convention as `Player` (entities.rs:11-14) so `hitbox_cells` logic is reusable |
| vx, vy | i16 | 1/16 cell per tick; unlike players the sim moves enemies, so knockback is applied to state (players are moved by the client, `EV_KNOCK` only advises, entities.rs:328) |
| hp | u16 | boss needs more than 255; players are `u8` health |
| facing | u8 | |
| state | u8 | AI state: idle, chase, attack windup, cooldown, phase (boss) |
| timer | u16 | ticks in the current state (a relative counter avoids storing an absolute tick like `dead_until`) |
| cooldown_until | u32 | next attack tick (as `Player.cooldown_until`) |
| target | u32 | player id or 0; cached but always recomputed when stale |
| last_hit_by, last_hit_tick | u32, u32 | kill credit, as in `Player` (entities.rs:22-23) |

About 40 bytes. `Nest { id u16, kind u8, x u16, y u16, respawn_at u32 }`, 11 bytes, regenerated from the seed on restore the way `decode` takes pickups from the fresh generation (entities.rs:213-219), only `respawn_at` read from bytes.

**Snapshot and hash cost.** Append `n_enemies u32, enemies, n_nests u32 (implied by generation, so only respawn_at values)` after the bags in `entities::encode` (entities.rs:165-190). Players stay first (the server reads the player section at a fixed offset, comment at :162). `decode` validates the exact total length from counts (entities.rs:219-260): add `MAX_ENEMIES` check and the extra section to that length arithmetic, hostile counts fail cleanly. Bump `FORMAT_VERSION` 5 to 6 (snapshot.rs:10); the repo's own comment says old state is refused and the game is not live (memory: resets are fine). Budget: 48 enemies x 40 B + 100 nests x 4 B = about 2.3 KB, trivial next to the chunk planes. The state hash already covers `entity_bytes` (sim.rs:339-343), so enemies join the hash for free, which is what makes desyncs visible.

**Entities view.** `ENTITY_BYTES = 18` (entities.rs:375). `put(type, id, active, sub, x, y, a, b)` as used at :396/:412. Add `ENT_ENEMY = 5`: sub = kind, a = state/anim (u16 = state | facing << 8), b = hp scaled to a percentage 0..100 (or a u16 if `b` is wide enough; check `put`). No view change in size. The client needs max hp per kind from a shared table (same pattern as `SPELLS` in `client/spells.ts`).

## 2. Determinism of the AI

All AI is a pure function `step_enemy(&mut self, idx)` of: the grid cells inside a small box around the enemy, `players` (sorted), `tick`, `seed`. No clocks, no float, no `HashMap`.

- **Targeting.** For each stepped enemy: among alive, active players, take the minimum squared distance in 1/16 cells (`i64`), ties broken by lowest id (iteration order is already id order, take strictly-less only). Aggro radius `AGGRO_CELLS` (e.g. 80) and a leash. Cost: O(P) per enemy, P at most 8 by `max_players`. Optionally cache `target` and re-evaluate every 8th tick, staggered by `(tick + id) % 8`, which is deterministic.
- **Line of sight** (for ranged kinds): integer DDA like `step_projectile` (spells.rs:186-236) capped at 48 steps; blocked by any non-EMPTY, non-gas cell.
- **Movement.** No A*. Three movement classes, each integer and O(box):
  - *Walker*: gravity and `vx` toward target; collide with the grid by testing the leading column of the hitbox; if blocked and the cell above the obstacle is free for 1-3 cells, step up (auto-climb), else jump (set `vy` impulse) at most every N ticks. Ledges: turn back unless the target is below.
  - *Flier*: `vx, vy` steered toward target + an rng-driven wobble `rng(seed, tick, id, 0, SALT_ENEMY_WOBBLE)`; cannot enter solids, slides along them.
  - *Burrower*: moves through DIRT, SAND, ROCK by clearing cells along its path via `Grid::set`/`carve`-style writes (bounded: a capsule of at most a few dozen cells per tick), so it wakes chunks through the normal `touch` path.
  Stuck-handling: if blocked for 60 ticks, pick a random heading from rng and ignore the target for 30 ticks. This is the same "dumb but cheap" that Noita uses for its creatures (see 9).
- **Attack timing** uses `state`/`timer`/`cooldown_until`, all in the hashed state, so every client reaches the same tick of windup, release, cooldown.
- **Tie-breaking and ordering.** Enemies stepped in id order; within a tick, projectiles first (as now, spells.rs:154), then enemies, then the hazard scan. Insert in `update_entities` (sim.rs:272) after `update_projectiles` and before respawns. Document in the tick-order comment (sim.rs:128-136) and as a new D-row.
- **No stateful rng.** Every random draw is `rng(seed, tick, id, k, SALT_ENEMY_*)` with new salts in `rng.rs` (the last assigned is 205), the pattern already used by cells and spawn (sim.rs:253).

## 3. Chunk sleeping (the hard part)

How sleeping works today. Two separate flags (grid.rs:47, :144-208): `active[c]` (chunk intersects the 576 x 320 rect around an active player, derived from player state in `refresh_active`, sim.rs:173-182) and `awake[c]` (pure optimisation, cleared when a chunk is quiet, scratch, not hashed). D7 compares sleep on and off; `active` is identical in both runs, only `awake` differs. A frozen (non-active) chunk is not simulated at all, and that **is** semantically visible by design, but it is a deterministic function of hashed state (player positions), so clients agree.

So the rule that keeps D7 true: **an enemy's behaviour may depend on `active` (or better, on player positions directly) but never on `awake`**.

Recommended rule ("stepped by proximity"): an enemy steps on tick t iff it lies within a rectangle `ENEMY_ACTIVE_W x ENEMY_ACTIVE_H` (e.g. 448 x 256, strictly inside the 576 x 320 active rect, so every cell the enemy touches, plus a margin, is in an `active` chunk) around some **active, alive** player. Computed per enemy from `players` directly, same loop shape as `refresh_active`, not from chunk flags. Otherwise it is **frozen by rule**: no movement, no timers, no AI, no damage. Consequences:

- It reads cells only in active chunks. Whether those chunks are `awake` is irrelevant: a sleeping chunk has, by the invariant, the same cell contents it would have if it had run. So reading is identical with sleeping on or off.
- It writes (burrow, boss lava burst) through `Grid::set`/`carve`, which call `touch` and wake the chunk and neighbours (grid.rs:105-133), as player digging already does. Sleeping stays invisible for the same reason `Dig` is.
- The boss arena trigger: a player enters the trigger radius, which is inside the rectangle, so the boss wakes. When all players leave, the boss freezes mid-fight. Cost: **the boss "pauses" when nobody is near**; acceptable, and it has a leash rule (heal 1 hp per 4 ticks while frozen is NOT allowed, since frozen means nothing runs; instead on the first stepped tick after `frozen_for` is large, restore hp. That needs a stored `last_stepped_tick` u32 field). Flag as a decision.
- Players with no active players: world frozen already (sim.rs:166-168), enemies with it.
- A frozen enemy standing in a tunnel that a player later reaches resumes exactly where it was: fine and cheap. A frozen enemy can be hurt by nothing (explosions are from entities that only run near players, but a bomb from a far player: the explosion loop must also be gated to stepped enemies or just allowed to damage regardless, both deterministic; allow, since `explode_at` is gated by the caster, who is active).

Alternative rejected: "always simulate every enemy". It makes enemies independent of players, but then an enemy far from every player reads cells in frozen chunks, and water would not flow there, lava would not move; enemies would walk through a world that is not simulated. Not wrong deterministically, but it does cost unbounded per-tick work (cap bounds it), and it makes snapshot and late-join identical anyway. Its real defect is that enemies in far chunks act on stale cells, so a sleeping-vs-frozen mix becomes subtle. Recommend the proximity rule.

D7 test to add: extend the D7 scenario with enemies near a player, one run with `sleep_enabled = false`, assert equal hashes; plus a scenario where an enemy sits just outside the rect, and one that straddles.

## 4. Bounded work

Constants (`tuning.rs`): `MAX_ENEMIES = 48` stored (decode refuses more, like `MAX_PROJECTILES`, entities.rs:238-243); `MAX_ENEMY_STEPS_PER_TICK = 24` (if more are in range, step the lowest ids, and the rest wait; deterministic because the in-range set derives from state; starvation is bounded because the total is capped at 48); per-enemy work: target scan (P <= 8), box collision (<= 5 x 10 cells x a few moves), LOS (<= 48 cells), burrow writes (<= 40 cells), projectile spawn (counts against the global 256 and a per-enemy cap of 2, boss 8; an over-cap attack is skipped silently and retried next tick, mirroring `MAX_BOMB_EXPLOSIONS_PER_TICK`, tuning.rs:98-100). A hostile client cannot influence any of this except by position, which is clamped (sim.rs:215-216).

Spawning options, best to worst:
1. **Generator nests + respawn timers (recommended).** The generator emits spots with a kind (like `PickupSpot`, gen.rs:290-296, `spot` placement at gen.rs:771-795, and the `Base` cache in sim.rs:20-26 so `restore` need not regenerate). Initial enemies exist at tick 0. When one dies, its nest sets `respawn_at = tick + ENEMY_RESPAWN` (say 3600 as `PICKUP_RESPAWN`, tuning.rs:15, or longer per tier) and spawns again only if `tick >= respawn_at` AND no alive player within `NEST_CLEAR_CELLS` (so nothing pops into view). Both conditions use state only. Bounded: one enemy per nest, at most 48 nests.
2. Spawned near players (Noita-ish "wave"): deterministic with rng, but it ties population to player position and makes the count a function of player movement; harder to balance and to explain. Reject for v1.
3. Generator-only, no respawn: simplest, but a cleared world is dead after ten minutes. Use for the boss (respawn only on a long timer or never).

## 5. Tiers

World bands at size L: surface 230, shallow top 260, deep top 800, repair depth 1420 (gen.rs:15-17, :221 `scale_u(h, 1420)`). Scale all by `Scale` like pickups so S/M work. Player has 100 hp (`HEALTH_MAX`, tuning.rs:15), `EXPLOSION_DAMAGE_MAX` 60, fire bolt 20, lava 1 hp / 2 ticks, fire 1 / 6, acid 1 / 4 (spells.rs:505-535). Enemy damage is `u8` per hit, via `apply_damage` with new cause codes `CAUSE_ENEMY_BASE = 40 + kind` (the existing range is 32-35, tuning.rs `CAUSE_*`).

Speeds in 1/16 cell per tick (player walking speed in `client/avatar.ts`; the controller is client-side, so pick enemy speeds as fractions: 16 = 1 cell per tick = 60 cells/s, far too fast; use 2-6, i.e. 7 to 22 cells/s).

| tier | band | enemy | hp | speed | attack | notes |
|---|---|---|---|---|---|---|
| T1 | surface to shallow top + 120 | **Slime** (walker) | 20 | 2 | contact 8 dmg, 40-tick cooldown, knockback | hops; killed by Push into water? no; Blast 2 hits. Drops nothing. Hurt by lava/fire. |
| T1b | same | **Beetle** (walker, tougher) | 40 | 3 | contact 12 | optional |
| T2 | shallow band | **Fire imp** (flier) | 30 | 4 | Fire bolt, 1 shot / 90 ticks, `FIRE_BOLT_DAMAGE` 20, range 120 with LOS; ignites oil, gunpowder and dirt-grown plants via `ignite` (spells.rs:274) | immune to FIRE and LAVA; water-damaged (1 hp / 4 ticks in WATER). Explodes oil pools: players can bait it. |
| T3 | deep top to repair depth | **Acid slime** (walker) | 60 | 3 | contact 15 + leaves an ACID cell trail every 20 ticks (cap 2 cells/tick); on death bursts 12 ACID cells | immune to ACID; hurt by FIRE |
| T3 | deep | **Burrower worm** | 90 | 2 (3 inside rock) | burst from the wall: contact 20, `dig` capsule of radius 3; ambush: stays dormant (state 0) until a player within 40 cells, then tunnels | hurt by LAVA/FIRE; wakes chunks as it digs |
| T4 | deep, last 15% | **Cave guard** (flier, shielded) | 140 | 4 | Bomb lob, 150-tick cooldown, `BOMB_RADIUS` 18 (reuses `BOMB`, spells.rs:262) | optional: skip in v1 |
| Boss | arena | **The Deep Mage** | 1200 | 2 (hover/teleport) | see below | |

**Boss.** Generated by a new `carve_arena` in `gen.rs`, called beside `carve_chambers` (gen.rs:908-946): one big ellipse (e.g. rx 70, ry 40 at L) centred on a path point in the last band (y between `deep_top` and `repair_depth - 40`, clear of the border via `near_border`, gen.rs:949), so it joins the traversal network and `repair_traversal` still holds. Floor flattened, a few rock pillars, no liquids inside, a bedrock ring is not needed. Add one nest of kind Boss at its centre (counted outside the 48 normal cap? make the cap 49 and note).

How players find it: a boss tells (a) a pickup pile of the 4 deep spells placed just outside the arena, (b) the `spawn_point`-like deterministic location recorded in the world, shown as a depth marker on the client UI (client knows the arena centre via a new `sim.boss_x/boss_y` getter or from the nest list in the entities view), and (c) a lava glow and gas pockets (existing gas/lava gen). Nothing in the sim reveals position beyond what the view already shows.

Phases (by hp thresholds, stored in `state`, hashed): 
1. 100-66 percent: hovers, aims Fire bolts at the nearest player every 60 ticks (reusing `FIRE_BOLT`, damage 20, ignites cells), plus a melee shove if a player is within 12 cells.
2. 66-33 percent: adds Bomb lobs (every 120 ticks) and summons 2 Fire imps (`MAX_ENEMIES` gate, at most 4 summoned alive, rng-chosen spawn cell inside the arena that is EMPTY).
3. Below 33 percent: enraged, speed x1.5, fire volley of 3 bolts in a fan every 90 ticks; `LAVA` ring spawn: 24 LAVA cells placed in an arc around the arena floor (bounded writes via `Grid::set`), lava wins over fire for hazard purposes, so players must jump. Each phase change is a state change, announced with `EV_ENEMY_PHASE`.

Spells: do NOT add boss spell ids to `NUM_SPELLS` (7); that array size is baked into `PLAYER_BYTES` (entities.rs:27) and `START_CHARGES`. Instead the boss reuses the same spell ids with their existing tables (`SPEED`, `GRAVITY_Q8`, spells.rs impact switch) and the projectile `owner` marks the source. Only if a new effect is needed (lava ring) is it done directly as a boss action, not a projectile.

On death: `EV_ENEMY_DEATH` (boss kind), a reward `Bag` via `drop_bag` (spells.rs:397) of near-full charges (e.g. 15/15/10/5; `drop_bag` merges and has the 64-cap), an `EV_BOSS_DEFEATED`, and the nest sets `respawn_at = u32::MAX` (never, until the room resets). "Win" is a client toast and a server achievement; a room reset stays the existing admin action (a game-end flow is a separate feature).

## 6. Interaction with materials

Yes, with a `hazard_scan` sibling `enemy_hazard_scan` (spells.rs:505) run right after it: for each enemy in id order that was stepped this tick, scan its hitbox cells (bounded: <= 8 x 10), apply per-kind immunity bitmask (`IMMUNE_FIRE|LAVA|ACID|WATER`) and a damage cadence by `(tick + id) % n`. This reads only the enemy's own hitbox inside the stepped rectangle, so chunk sleeping cannot change it (same argument as the player scan). Players use the world: knock enemies into acid or lava (Push and Blast set enemy `vx, vy`, which the sim integrates), drop a Bomb to carve a pit under them, Fire bolt onto an oil-soaked imp, water dousing for imps. Explosions: extend `explode_at` (spells.rs:469) with a second loop over enemies in id order using the same linear falloff and knockback, skipping enemy-owned explosions (no friendly fire from boss bombs). Projectile hits: `step_projectile`'s `boxes` (spells.rs:164-172) currently holds players only and `impact(.., hit: Option<u32>)` takes a player id; widen the id space: enemy boxes get ids with the high bit set, and `hit_player` becomes `hit_target`. An enemy-owned bolt (`owner & ENEMY_OWNER_BASE != 0`) skips enemy boxes and, when it hits a player, records no `last_hit_by` credit.

Gotcha to review: `apply_damage` (spells.rs:356) is gated by `damage_from_players()` for causes below `NUM_SPELLS`; enemy-caused damage needs its own gate `damage_from_enemies()`.

## 7. Multiplayer and modes

Config: 16 bytes with four reserved, which `decode` requires to be zero (config.rs:66-68). Add `enemies: u8` in byte 12 (0 off, 1 normal, 2 hard, 3 boss only). Existing rooms keep byte 12 = 0, so old config bytes stay valid, no `CONFIG_VERSION` bump needed (but the state hash differs only when enabled). Add the getter `has_enemies()` next to `damage_from_env` (config.rs:96) and mirror in `shared/room.ts`. Presets: `classic_sandbox` (config.rs:30) and `creative` (:50) 0; `caves_pvp` 0 (or 1 as an option; recommend a new preset "Caves co-op": `damage = 1` if that value means env only; check what `damage` 0/1/2 mean at config.rs:93-97). Enemies need terrain `TERRAIN_CAVES` (nests come from the generator); the config validator should reject `enemies != 0` for other terrains.

Kill credit: reuse `last_hit_by`/`last_hit_tick` on `Enemy` with `KILL_CREDIT_TICKS` (tuning.rs). Death emits `EV_ENEMY_DEATH`: `player = killer (0 if none)`, a = enemy id, b = kind, c = cause. Other new events (`EV_*`, entities.rs:322-340, `EVENT_BYTES = 17` has room: `kind u8, player u32, a,b,c i32`): `EV_ENEMY_SPAWN` (a,b = position, c = kind), `EV_ENEMY_HURT` (a = id, b = damage, c = hp left; limit emission: one per enemy per tick), `EV_ENEMY_DEATH`, `EV_ENEMY_PHASE`, `EV_BOSS_DEFEATED`. Per-tick event volume is bounded by 24 stepped enemies. Achievements: today the client sends a claim for `EV_DEATH` to the server (worker.ts:255, `encodeClaim`); enemy kills need an analogous claim ("first kill", "slime 50", "boss") and a server-side check against the achievements list (`shared/achievements.ts`); server verifies nothing in sim state (no server-side stepping), as with the existing claims. Players only see plain names (CLAUDE.md), so kill-feed uses names, never `name#id`. Server logs must go through `log.event` with new catalogue names, and kills are summarised in `input.summary`-style aggregates, never one line per hit.

Co-op fairness: enemy hp scales with players only if a deterministic function of the count of active players (a stat table index, evaluated at spawn); not in v1.

## 8. Client

- Rendering: a new `ENT_ENEMY` branch in `gameFrame` (`client/worker.ts:399-514`, where players and bags are drawn from `entities()`), after the bag drawing at :503. Sprites as pixel rows like `pushGrid`/`pushBag` in `fx.ts` (:30, :40): per kind a 2-frame idle and a 2-frame move grid, a hurt flash, and a larger grid (24 x 24) for the boss. Facing from `a`. Use the existing `Particles` (fx.ts:188) for hurt/death.
- Health bars: a 1-pixel-high rect strip above the sprite from `b` (percent), only when hurt; boss gets a bottom-of-screen bar via a new HUD element in `client/render.ts`/`main.ts` fed by the boss entity.
- Sounds: add keys to `client/sfx.ts` (spell sounds are looked up via `SPELL_SFX`, worker.ts:586-590, `sfxAt` at positions) for enemy hurt, die, imp cast, boss roar and phase change. Use the existing budget (`sfxBudget = 24`, worker.ts:574) and the `quiet` flag during catch-up (:573).
- Interpolation: enemy positions come from sim state per tick; the player view interpolates via `poses`; enemies should lerp between ticks the same way (state is authoritative, render only).
- Event handling: add `EV_ENEMY_*` cases in `spellFx` (worker.ts:569-650) and the TS constants next to `EV_DEATH` (worker.ts:22-30, from `client/protocol.ts` or generated).
- Prediction: none. Enemies are not predicted; the local sim already runs in lockstep with the server's tick stream, so enemies appear at the same tick as the sim says (same as projectiles).

## 9. Prior art (only pages fetched)

- **Age of Empires lockstep** (Game Developer, "1500 Archers on a 28.8", https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond, fetched): every machine runs the same simulation from the same commands; code paths must match; the RNG is seeded and synchronised and the number of random calls must be identical everywhere, including for cosmetic randomness (a sound's random choice desynced them); pathing and targeting are checksummed with the world and a mismatch stops the game; tiny early differences compound (a deer foraging differently). Lessons for us: our counter-based `rng(seed, tick, x, y, salt)` removes the "same number of calls" hazard entirely; keep any cosmetic randomness (sprite variation, sound pitch) in the client and out of the sim; the state hash must include enemies from the first commit so a divergence is caught immediately.
- **Noita creatures** (https://noita.wiki.gg/wiki/Enemies, fetched, a list page with little behaviour detail): creatures belong to factions and retaliate when hit; worms tunnel and bigger ones destroy more material types; fire mages, acid slimes, healers, mimics and bosses with minions exist; robots resist most damage except explosions. The page said little about depth placement and nothing about AI internals, so the tier table above is our design, not a claim about Noita's. Useful ideas: faction (enemies do not hurt each other, which we model as "enemy-owned explosions skip enemies"), immunities per kind, and the worm as a terrain-modifying enemy (our burrower).
- Not fetched (do not cite): any StarCraft write-up. I tried the Noita fandom page, which returned HTTP 402.

## 10. Recommended design and slice plan

Design: as above. Enemy = `Enemy` struct + `Nest`; stats table `ENEMY_STATS[kind]` in `tuning.rs`; AI in a new `sim/src/enemy.rs` (impl `Sim`); proximity-gated stepping; per-kind immunity bitmask; reuse `apply_damage`, `explode_at`, projectile list and `drop_bag`; config byte 12.

Each slice: its own commits (checklist: state + snapshot, then AI, then gen, then tests, then client), `pnpm test:determinism` and `pnpm check` green before each commit, independent Sonnet reviewer for slices 1 and 3.

**Slice 1: one tier end to end (Slime).** Touches `sim/src/enemy.rs` (new), `entities.rs` (struct, encode/decode, view, `ENT_ENEMY`, events), `sim.rs` (fields, `update_entities` hook, `new_with_base`, `Base` gets nests), `snapshot.rs` (version 6), `config.rs` and `shared/room.ts` (byte 12, getter, validation), `tuning.rs`, `rng.rs` (salts), `gen.rs` (nest spots for T1), `spells.rs` (player projectile/explosion hits on enemies, `enemy_hazard_scan`, `apply_damage` gate), `lib.rs` (nothing if the view size is unchanged), `client/worker.ts` + `client/fx.ts` (sprite, health bar), tests: D5 snapshot round trip with enemies, D7 sleeping on/off with enemies, D1/D2 cross-engine hash, a 'hostile snapshot' decode test, unit tests for targeting ties and for the proximity rule. Cost: largest slice, about 1.5-2x a normal feature slice, one Sonnet worker, maybe 1.5-2.5 M tokens of Sonnet work (rough), plus reviewer.

**Slice 2: more tiers and enemy spells.** Imp (flier, Fire bolt via projectile list with enemy-owner high bit, knockback, `EV_KNOCK`), acid slime (trail), worm (burrow). Touches `enemy.rs`, `spells.rs` (`step_projectile` boxes, `impact`, `explode_at`), `tuning.rs`, `gen.rs` (band kinds), client sprites and sfx. Cost: about one normal slice, Sonnet.

**Slice 3: boss.** Arena carve in `gen.rs` with a traversal test, boss nest and phases in `enemy.rs`, `EV_ENEMY_PHASE`, drop bag and `EV_BOSS_DEFEATED`, boss HUD bar. Touches `gen.rs` (tests there check traversal and world invariants, so run the full world tests), `enemy.rs`, `tuning.rs`, client HUD (`render.ts`/`main.ts`), `worker.ts`. Cost: one normal slice plus reviewer, because arena carving can break the guaranteed-path invariants.

**Slice 4: multiplayer polish.** Server-side claims and achievements for kills and boss (`shared/events.ts`, `shared/achievements.ts`, `server/`), `log.event` names, dashboard counts (aggregate only), preset "Caves co-op", balance pass with two-tab browser checks (CLAUDE.md "Open it and look"), `docs/DECISIONS.md` rows and `engineering-decisions.md` entry. Cost: small to medium, Sonnet, plus a playtest by the user.

Haiku can take: renaming, adding the TS constants for events, sprite pixel grids once the format is fixed. The session model keeps the brief writing and review of Architectural decisions.

## 11. Architectural decisions for the user to weigh

1. **Enemy stepping rule.** (a) frozen outside a proximity rectangle derived from player positions (recommended: D7-safe, cheap, boss pauses when alone); (b) always simulated (enemies act on frozen chunks, more work, subtle); (c) use chunk `active` flags directly (simple but couples enemy behaviour to chunk granularity, a 64-cell step function). Hard to reverse, because it shapes balance and the hash.
2. **Where spawns come from.** Nests with timers (recommended) versus near-player spawning versus one-shot. Costs later: wave modes would want (2).
3. **State representation.** Separate `Vec<Enemy>` sorted by id with a global id counter (recommended) versus reusing `Player` rows with a flag (would inflate `PLAYER_BYTES` and the server's fixed-offset reader) versus spawn-order list. Snapshot format bump either way.
4. **Enemy projectiles.** Reuse the projectile list with a high bit in `owner` (recommended, small) versus a separate list (cleaner, doubles the stepping code). Also the `hit: Option<u32>` id-space change touches the shared input path of damage.
5. **Boss spells.** Reuse existing spell ids and their tables (recommended) versus add boss-only spell ids (grows `NUM_SPELLS`, hence `PLAYER_BYTES` and `PICKUP_CHARGES`, with another format break).
6. **Config.** Byte 12 as `enemies` (recommended, backward compatible) versus a CONFIG_VERSION 2 with a new field layout, versus a hardcoded "caves always have enemies" (breaks Caves PvP's feel).
7. **HP width.** `u16` hp in state versus `u8` (simpler, matches players, but the boss would need a damage divisor).
8. **Boss respawn.** Never (room reset only) versus timer. Interaction with admin reset needs a decision.
9. **Who moves enemies.** The sim integrates enemy velocity (required here), unlike players, whose client moves them from the controller. Hence enemies are not predicted. If later you want smoother feel, interpolation is render-only.
10. **Frozen-boss healing** (needs a stored `last_stepped_tick`) versus no healing.

## 12. Risks

- **Determinism.** Biggest risk is an accidental float in a distance or steering calculation (clippy denies it, `#![deny(clippy::float_arithmetic)]`), iteration over an unsorted structure, and using `awake` (not `active`) in AI. Also `usize` in the encoding (invariant 7), and a stepped-set rule that accidentally reads a frozen enemy's cell state from a chunk that hasn't run. Tests: cross-engine D2 on a scenario with all enemy kinds, D7 variants, a replay test with enemies and late join (snapshot mid-fight, restore, assert hash equal over 600 ticks).
- **Performance** (256 MB shared-CPU machine; the sim runs in each client and the server verifies). Enemy logic is about 24 stepped x (box scan + LOS) per tick, negligible compared with a 576 x 320 active region of cell updates (`ran_chunks` measured in P1 gate). The worst case is burrowers and bombs waking chunks; the burrow writes are capped and `MAX_BOMB_EXPLOSIONS_PER_TICK` is already 8. Add enemy cost to the P1 performance gate. Memory is a few KB.
- **Snapshot size.** About 2-3 KB added, but the exact-length decode and the server's fixed player offset are fragile points (review crit 10 style bug). The `snapshot::size` helper is asserted equal to `write().len()` (snapshot.rs:45-47), which will catch a mismatch if the new section is in both.
- **Late join and catch-up.** A client that joins mid-fight restores from a snapshot; enemy ids and the id counter must be in the snapshot, or a spawned enemy gets a different id and projectile owners diverge. Put `next_enemy_id` in the hashed bytes.
- **Balance and griefing.** A player can lure a boss and dig around; leash and phase logic must not depend on terrain the player can change in unbounded ways. Enemy damage in PvP rooms must be gated by config.
- **Pickups-and-nests collision.** The generator must keep nests off pickup cells and out of liquids and the guaranteed path, as acid pools are (gen.rs:591); spawn tests will find stuck spawns.
- **Mover bugs.** Enemies stuck in terrain after a bomb or paint input: add an "embedded" rescue that moves them up to the first free cell, deterministic.
- **Citations.** The Noita page gave little behaviour detail; the tier table is original design.
