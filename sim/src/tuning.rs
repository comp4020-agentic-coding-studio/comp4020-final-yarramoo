//! Gameplay constants (plan 6.6, 6.7). All integers; one place so balance changes never touch logic.

/// Spell ids: 0 Push, 1 Blast, 2 Water, 3 Rose seed, 4 Fire bolt, 5 Bomb, 6 Dig, 7 Acid Flask, 8 Oil Flask, 9 Wall, 10 Lava Flask, 11 Black Hole (plan 6.7; appended so ids stay stable). Teleport (12) was skipped, see docs/research/f3-worker-report.md.
pub const NUM_SPELLS: usize = 12;
/// Infinite charges (the starter spells).
pub const INFINITE: u16 = u16::MAX;
/// Charges a player starts with, per spell: Push and Blast are infinite.
pub const START_CHARGES: [u16; NUM_SPELLS] = [INFINITE, INFINITE, 0, 0, 0, 0, INFINITE, 0, 0, 0, 0, 0];
/// Charges one pickup of each spell grants (plan 6.7).
pub const PICKUP_CHARGES: [u16; NUM_SPELLS] = [0, 0, 15, 15, 10, 5, 0, 8, 10, 10, 4, 2];
/// Ticks before a collected pickup is available again (plan 14: 60 s).
pub const PICKUP_RESPAWN: u32 = 3600;
/// Pickups are collected this many cells below the feet as well as inside the hitbox (the user, 5 Nov: on narrow
/// footing the hitbox could sit just above a pickup it visibly touched). Pickups only; damage keeps the hitbox.
pub const PICKUP_REACH_BELOW: i32 = 2;

pub const HEALTH_MAX: u8 = 100;

/// Player hitbox in cells, anchored at the feet centre (plan 6.6).
pub const HITBOX_W: i32 = 5;
pub const HITBOX_H: i32 = 10;
/// Positions are in 1/16 cell.
pub const POS_SHIFT: i32 = 4;
pub const POS_ONE: i32 = 1 << POS_SHIFT;

/// Active rectangle around an active player (plan 6.5): the 480 x 270 view plus margin.
pub const ACTIVE_W: i32 = 576;
pub const ACTIVE_H: i32 = 320;

/// Persisted player entities are capped so a hostile id stream cannot grow state without bound.
pub const MAX_PLAYERS: usize = 1024;
/// A new player spawns at the world's centre column plus an rng offset of up to this many cells either way.
pub const SPAWN_JITTER: u32 = 48;

// ---- spells and projectiles (plan 6.6, 6.7); every number a designer would tune lives here ----------

/// Projectile position and velocity are in 1/256 cell (velocity per tick).
pub const PROJ_SHIFT: i32 = 8;
pub const PROJ_ONE: i32 = 1 << PROJ_SHIFT;
/// Hard caps: every client runs every projectile, so an excess cast is refused (`CastRejected`).
pub const MAX_PROJECTILES: usize = 256;
pub const MAX_PROJECTILES_PER_PLAYER: usize = 12;
/// A bolt that has not hit anything after this many ticks is removed.
pub const PROJ_MAX_AGE: u16 = 180;
/// The owner cannot be hit by their own bolt for this many ticks after the cast.
pub const OWNER_GRACE: u16 = 10;
/// Fastest a bolt may fall or fly on one axis, so the DDA stays within `MAX_SUBSTEPS`.
pub const PROJ_MAX_SPEED: i32 = 8 * PROJ_ONE;
pub const MAX_SUBSTEPS: i32 = 8;
/// F5 enemy-owned projectiles: `owner` has this high bit set, then the enemy kind in bits 16..24 and its id in bits
/// 0..16. Player ids stay below it (`Sim::join` refuses an id with the bit set), so an enemy owner never equals a
/// player id. At most `MAX_ENEMY_PROJECTILES` enemy bolts fly at once (they never count toward a player's cap).
pub const ENEMY_OWNER: u32 = 0x8000_0000;
pub const MAX_ENEMY_PROJECTILES: usize = 16;

/// Spells the sim implements; a disabled spell's cast is refused.
pub const SPELL_ENABLED: [bool; NUM_SPELLS] = [true, true, true, true, true, true, true, true, true, true, true, true];
/// Ticks between casts of the same spell.
pub const COOLDOWN: [u32; NUM_SPELLS] = [20, 90, 10, 10, 15, 60, 18, 25, 20, 45, 60, 120];
/// Launch speed, 1/256 cell per tick (Push 5 cells a tick; Water and Rose are lobbed slower).
pub const SPEED: [i32; NUM_SPELLS] = [1280, 0, 768, 768, 896, 640, 0, 768, 768, 0, 768, 384];
/// Downward acceleration, 1/256 cell per tick per tick.
pub const GRAVITY_Q8: [i32; NUM_SPELLS] = [0, 0, 10, 10, 4, 20, 0, 10, 10, 0, 10, 0];
/// Knockback impulses in 1/16 cell per tick (plan 6.7).
pub const KNOCK_PUSH: i32 = 64;
pub const KNOCK_BLAST: i32 = 96;
/// Blast reach in cells, and the half-angle of its cone: 45 degrees (the test is `2 * dot^2 >= |d|^2`).
pub const BLAST_RADIUS_CELLS: i32 = 24;
/// Dig clears a capsule: the segment from the chest `DIG_REACH` cells along the aim, thickened by `DIG_RADIUS`
/// cells. `Grid::dig` clamps both, so one cast clears at most (2r+1) x (reach+2r+1) cells.
pub const DIG_RADIUS: i32 = 7;
pub const DIG_REACH: i32 = 14;
/// Height of a player's chest above the feet, in cells: where bolts leave and what the cone aims at.
pub const CHEST: i32 = 5;
pub const WATER_BURST_CELLS: usize = 60;
/// Flask bursts (Acid, Oil, Lava): the most Empty cells each fills; same disc as water, `WATER_BURST_R2`.
pub const ACID_BURST_CELLS: usize = 50;
pub const OIL_BURST_CELLS: usize = 70;
pub const LAVA_BURST_CELLS: usize = 60;
/// Wall: a rock slab `WALL_THICK` x `WALL_LEN` cells, centred `WALL_REACH` cells along the aim from the chest.
pub const WALL_THICK: i32 = 3;
pub const WALL_LEN: i32 = 12;
pub const WALL_REACH: i32 = 10;
/// Black Hole: radius (cells) of the disc of solids cleared each tick, lifetime in ticks, how far it pulls
/// players (cells), the pull per tick (1/16 cell per tick, through `EV_KNOCK`), and the cap per owner.
pub const BH_RADIUS: i32 = 3;
pub const BH_LIFETIME: u16 = 150;
pub const BH_PULL_RANGE: i32 = 20;
pub const BH_PULL: i32 = 12;
pub const MAX_BLACK_HOLES_PER_PLAYER: usize = 2;
/// Squared radius (cells) of the disc a water burst fills, in Empty cells only.
pub const WATER_BURST_R2: i32 = 36;
pub const SEED_BURST_CELLS: u32 = 8;
pub const SEED_BURST_R: u32 = 3;

// ---- damage, death and respawn (M5, plan 6.8) ----------------------------------------------------------

/// Explosion damage at distance 0; falls off linearly to 0 at the radius.
pub const EXPLOSION_DAMAGE_MAX: i32 = 60;
/// Damage radius of a gunpowder blast in the world (the user, 5 Nov: blasts near burning coal should hurt). The grid
/// carve stays `grid::BLAST_RADIUS` (4), so terrain destruction is unchanged; only players and enemies feel the reach.
pub const GUNPOWDER_DAMAGE_RADIUS: i32 = 10;
/// Explosion knockback at distance 0 (1/16 cell per tick); falls off linearly to 0 at 1.5 radii.
pub const KNOCK_EXPLOSION: i32 = 96;
/// Ticks a dead player stays dead before the respawn.
pub const DEATH_TICKS: u32 = 180;
/// A hit counts toward a kill credit for this many ticks.
pub const KILL_CREDIT_TICKS: u32 = 300;
/// Cause codes carried by `EV_DEATH`: a spell id 0..NUM_SPELLS is that spell; environmental causes sit in a separate range so adding spells never collides:
pub const CAUSE_FIRE: u8 = 32;
pub const CAUSE_LAVA: u8 = 33;
pub const CAUSE_GUNPOWDER: u8 = 34;
pub const CAUSE_ACID: u8 = 35;

// ---- Fire bolt and Bomb (M5 slice 2, plan 6.7) ---------------------------------------------------------

/// Fire bolt: the disc of this radius (cells) around the impact is set alight (Empty and gas cells only).
pub const FIRE_BOLT_RADIUS: i32 = 3;
/// Fire bolt: health taken by a direct hit on a player.
pub const FIRE_BOLT_DAMAGE: u8 = 20;
/// Bomb: blast radius in cells; `carve` clears the disc and `explode_at` damages inside it.
pub const BOMB_RADIUS: i32 = 18;
/// Bomb: ticks of flight after which it explodes in mid-air (must stay below `PROJ_MAX_AGE`).
pub const BOMB_FUSE: u16 = 120;
/// Bound on the work one tick can spend on bomb explosions (each carves about 1,018 cells). A bomb past
/// the cap waits where it is and tries again next tick, in spawn order.
pub const MAX_BOMB_EXPLOSIONS_PER_TICK: u32 = 8;

// ---- dropped bags (M5 slice 3) -------------------------------------------------------------------------

/// A bag holds every finite spell: index k is spell `BAG_SPELL_IDS[k]` (the ids that start with 0 charges).
/// Push, Blast and Dig are infinite and never bagged.
pub const BAG_SPELL_IDS: [usize; 9] = [2, 3, 4, 5, 7, 8, 9, 10, 11];
pub const BAG_SPELLS: usize = BAG_SPELL_IDS.len();
/// Ticks a bag lasts: 90 s at 60 ticks a second.
pub const BAG_LIFETIME: u32 = 5400;
/// At most this many bags exist; a new one past the cap evicts the oldest (index 0) and its charges are lost.
pub const MAX_BAGS: usize = 64;
/// A drop within this many cells (Chebyshev: `max(|dx|, |dy|)`) of an existing bag merges into it.
pub const BAG_MERGE_CELLS: i32 = 8;

// ---- heal pickups (Brief E) ------------------------------------------------------------------------------

/// A killed enemy drops a heal when `rng(seed, tick, x, y, SALT_HEAL_DROP) % HEAL_DROP_ONE_IN == 0`; the boss always does.
pub const HEAL_DROP_ONE_IN: u32 = 3;
/// Hit points a heal restores (capped at `HEALTH_MAX`).
pub const HEAL_AMOUNT: u8 = 25;
/// Ticks a heal lasts: 60 s at 60 ticks a second.
pub const HEAL_LIFETIME: u32 = 3600;
/// At most this many heals exist; a new one past the cap evicts the oldest (index 0).
pub const MAX_HEALS: usize = 16;
/// A heal dropped inside solid ground rises at most this many cells to the first open (Empty or gas) cell; past
/// that it is not dropped (review E: a buried heal could never be reached and held a slot for its whole life).
pub const HEAL_RISE_MAX: usize = 12;

// ---- pickup spells by depth band (F3) ------------------------------------------------------------------

/// Spells a pickup spot can give, `(spell id, weight)`, by band (0 shallow, 1 deep). Chosen per spot by
/// counter-based rng (`SALT_PICKUP_SPELL`); the deep rarities (Black Hole) weigh half the others.
pub const PICKUP_TABLE: [&[(u8, u32)]; 2] = [
    &[(2, 2), (3, 2), (7, 2), (8, 2), (9, 2)],
    &[(4, 2), (5, 2), (10, 2), (11, 1)],
];

// ---- enemies (F4, docs/research/enemies-design.md) ------------------------------------------------------

/// Enemy kinds: 0 Slime. Later slices append (ids stay stable).
pub const ENEMY_SLIME: u8 = 0;
pub const ENEMY_IMP: u8 = 1;
pub const ENEMY_ACID_SLIME: u8 = 2;
pub const ENEMY_WORM: u8 = 3;
pub const ENEMY_BOSS: u8 = 4;
pub const NUM_ENEMY_KINDS: usize = 5;
/// At most this many enemies exist (decode refuses more), and at most this many step per tick (lowest ids first).
/// F5 raised this from 48: at size L the generator places 25 slimes + 8 imps + 10 acid slimes + 8 worms = 51.
pub const MAX_ENEMIES: usize = 64;
pub const MAX_ENEMIES_STEPPED: usize = 24;
/// An enemy steps only inside this rectangle (cells) around an active, alive player; it is strictly inside the
/// chunk-activity rectangle (`ACTIVE_W` x `ACTIVE_H`). It is computed from `players`, never from `grid.awake`.
pub const ENEMY_ACTIVE_W: i32 = 448;
pub const ENEMY_ACTIVE_H: i32 = 256;
/// Immunity bits: an enemy of a kind with the bit set takes no damage from that hazard.
pub const IMMUNE_FIRE: u8 = 1;
pub const IMMUNE_LAVA: u8 = 2;
pub const IMMUNE_ACID: u8 = 4;
/// Weakness bits: the hazard hurts this kind (`enemy_hazard_scan`), on top of the shared lava, fire and acid rules.
pub const WEAK_WATER: u8 = 1;

/// Per-kind stats: hp, hitbox width and height (cells), contact damage, contact cooldown (ticks), immunity mask.
#[derive(Clone, Copy, Debug)]
pub struct EnemyStats {
    pub hp: u16,
    pub w: i32,
    pub h: i32,
    pub contact_damage: u8,
    pub contact_cooldown: u32,
    pub immune: u8,
    pub weak: u8,
}
pub const ENEMY_STATS: [EnemyStats; NUM_ENEMY_KINDS] = [
    EnemyStats { hp: 20, w: 5, h: 4, contact_damage: 8, contact_cooldown: 40, immune: 0, weak: 0 },
    // Fire imp: flies, fires bolts (no contact damage); immune to fire and lava, hurt by water.
    EnemyStats { hp: 30, w: 5, h: 4, contact_damage: 0, contact_cooldown: 40, immune: IMMUNE_FIRE | IMMUNE_LAVA, weak: WEAK_WATER },
    // Acid slime: a slower, tougher walker; immune to acid (fire hurts it at the normal rate).
    EnemyStats { hp: 60, w: 5, h: 4, contact_damage: 15, contact_cooldown: 40, immune: IMMUNE_ACID, weak: 0 },
    // Burrower worm: tunnels through rock; no immunities (lava and fire hurt it at the shared rate).
    EnemyStats { hp: 90, w: 5, h: 4, contact_damage: 20, contact_cooldown: 40, immune: 0, weak: 0 },
    // The Deep Mage (F6): a big flier that makes the lava ring, so immune to fire and lava; contact shove 20.
    EnemyStats { hp: 800, w: 11, h: 14, contact_damage: 20, contact_cooldown: 40, immune: IMMUNE_FIRE | IMMUNE_LAVA, weak: 0 },
];
/// Enemy damage causes carried by `EV_DEATH`: `CAUSE_ENEMY_BASE + kind` (the environmental range above ends at 35).
pub const CAUSE_ENEMY_BASE: u8 = 40;
/// Slimes the generator places at size L (scaled by area, at least `ENEMY_SLIMES_MIN`), and the no-slime zone
/// around the surface spawn: this many columns either side of the world centre, within `ENEMY_SPAWN_ROWS` rows
/// of the shallow top (the spawn column is the centre plus an rng offset of at most `SPAWN_JITTER` plus 7 * 15).
pub const ENEMY_SLIMES_L: i32 = 25;
pub const ENEMY_SLIMES_MIN: i32 = 8;
pub const ENEMY_SPAWN_CLEAR: i32 = 160;
pub const ENEMY_SPAWN_ROWS: i32 = 60;
/// Slime movement, 1/16 cell and 1/16 cell per tick: gravity per tick, fastest fall, jump and hop impulses, the
/// distance (cells) inside which it hunts, and the hop cooldown (`base` plus an rng draw below `jitter`).
pub const SLIME_GRAVITY: i32 = 1;
pub const SLIME_FALL_MAX: i32 = 48;
pub const SLIME_JUMP_VY: i32 = 12;
pub const SLIME_HOP_VX: i32 = 5;
/// Extra jump impulse when a target is more than 4 cells above and within 24 cells sideways.
pub const SLIME_JUMP_UP_BONUS: i32 = 3;
/// Cells a blocked slime tries stepping up (1..=this) before giving up on the move.
pub const SLIME_STEP_UP_CELLS: i32 = 3;
pub const SLIME_IDLE_JUMP_VY: i32 = 8;
pub const SLIME_IDLE_HOP_VX: i32 = 2;
pub const SLIME_AGGRO_CELLS: i32 = 120;
pub const SLIME_HOP_BASE: u32 = 30;
pub const SLIME_HOP_JITTER: u32 = 20;
pub const SLIME_IDLE_BASE: u32 = 60;
pub const SLIME_IDLE_JITTER: u32 = 60;
/// Fastest an enemy moves on one axis (knockback is clamped to this), so one tick's movement stays bounded.
pub const ENEMY_MAX_SPEED: i32 = 128;
/// How far up (cells) the embedded rescue looks for the first free spot.
pub const ENEMY_RESCUE_CELLS: i32 = 64;
/// A contact hit knocks the player this much (1/16 cell per tick), away from the enemy and up.
pub const CONTACT_KNOCK_X: i32 = 40;
pub const CONTACT_KNOCK_Y: i32 = -24;
/// Damage a player's spells do to enemies (players take none from Push or Blast). Fire bolt and the explosions
/// reuse their player numbers. Knockback on an enemy is the player's impulse divided by `ENEMY_KNOCK_DIV`, and
/// lifts it at least `ENEMY_KNOCK_LIFT` (1/16 cell per tick) so a grounded slime actually leaves the floor.
pub const PUSH_ENEMY_DAMAGE: u16 = 5;
pub const BLAST_ENEMY_DAMAGE: u16 = 8;
pub const ENEMY_KNOCK_DIV: i32 = 4;
pub const ENEMY_KNOCK_LIFT: i32 = 8;

// ---- fire imp (F5) --------------------------------------------------------------------------------------

/// Imps placed at size L (scaled by area, at least `ENEMY_IMPS_MIN`).
pub const ENEMY_IMPS_L: i32 = 8;
pub const ENEMY_IMPS_MIN: i32 = 3;
/// Flier speed (1/16 cell per tick), the distance (cells) it hunts from, and the band it keeps from its target.
pub const IMP_SPEED: i32 = 3;
pub const IMP_AGGRO_CELLS: i32 = 160;
pub const IMP_NEAR_CELLS: i32 = 40;
pub const IMP_FAR_CELLS: i32 = 60;
/// A Fire bolt every this many ticks, at targets within `IMP_FIRE_RANGE` cells with a clear line. The line is only
/// tested when `(tick + id) % IMP_LOS_EVERY == 0`, and walks at most `LOS_MAX_STEPS` cells.
pub const IMP_FIRE_TICKS: u32 = 90;
pub const IMP_FIRE_RANGE: i32 = 120;
pub const IMP_LOS_EVERY: u32 = 15;
pub const LOS_MAX_STEPS: i32 = 120;
/// Hp an imp loses to water: 1 every this many ticks.
pub const IMP_WATER_EVERY: u32 = 4;

// ---- acid slime (F5) ------------------------------------------------------------------------------------

/// Acid slimes placed at size L (scaled by area, at least `ENEMY_ACID_SLIMES_MIN`), on deep floors.
pub const ENEMY_ACID_SLIMES_L: i32 = 10;
pub const ENEMY_ACID_SLIMES_MIN: i32 = 3;
/// Hop speed (slower than the Slime's `SLIME_HOP_VX`) and the extra ticks between hops.
pub const ACID_SLIME_HOP_VX: i32 = 3;
pub const ACID_SLIME_HOP_EXTRA: u32 = 15;
/// While hunting it drops one ACID cell at its feet every this many ticks (`(tick + id) % N == 0`); in all, at most
/// `ACID_TRAIL_PER_TICK` trail cells are written per tick whatever the number of slimes.
pub const ACID_TRAIL_EVERY: u32 = 20;
pub const ACID_TRAIL_PER_TICK: u32 = 1;
/// A dying acid slime bursts into at most this many ACID cells (Empty cells of the disc around it only).
pub const ACID_DEATH_CELLS: usize = 12;

// ---- burrower worm (F5) ---------------------------------------------------------------------------------

/// Worms placed at size L (scaled by area, at least `ENEMY_WORMS_MIN`), buried in deep rock.
pub const ENEMY_WORMS_L: i32 = 8;
pub const ENEMY_WORMS_MIN: i32 = 3;
/// A worm is dormant (state bit 0 clear) until an alive player is within this many cells, then hunts for good.
pub const WORM_WAKE_CELLS: i32 = 40;
/// It tunnels toward the nearest player within this many cells. Speeds are 1/16 cell per tick per axis: slower in
/// rock (the centre cell is solid) than in open space.
pub const WORM_HUNT_CELLS: i32 = 120;
pub const WORM_SPEED_ROCK: i32 = 2;
pub const WORM_SPEED_OPEN: i32 = 4;
/// Each stepped tick an awake worm digs the disc of this radius around its centre (`Grid::dig`: at most
/// `(2 * WORM_DIG_RADIUS + 1)^2` = 49 cells looked at, bedrock and liquids stay).
pub const WORM_DIG_RADIUS: i32 = 3;
/// Placement: the worm's centre has this many cells of solid Rock in every direction (a (2n+1) square).
pub const WORM_BURIED_CELLS: i32 = 6;

// ---- falling rock v0 -------------------------------------------------------------------------------------

/// A Seed stroke writes a cell only when `rng % PAINT_SEED_ONE_IN == 0`: about 1 cell in 16 of each disc, so
/// expected 3 seeds at radius 4 (a 49-cell disc) and 50 at radius 16 (797 cells); the seed-1 tick-0 stroke
/// at (200,200) measured 7 and 48.
pub const PAINT_SEED_ONE_IN: u32 = 16;
/// Removed solid cells recorded per tick (seeds derived from them; extras dropped), cells in a free island (a fill reaching this is anchored), and total
/// flood cell visits per tick (seeds past it are dropped, not carried: carrying would be hidden state).
pub const MAX_ISLAND_REMOVED: usize = 8192;
pub const ISLAND_MAX: usize = 400;
pub const ISLAND_WORK_MAX: usize = 4000;
/// Falling rock v0.5 (D-190): a free island of at most this many cells falls as itself, one cell per tick; larger
/// ones crumble. A generated tree is about 80 cells. At most `FALL_MAX_ISLANDS` fall at once (state, hashed), so a
/// tick moves at most 16 x 120 = 1920 cells and floods at most 16 x 121 cells before the seed pass.
pub const FALL_ISLAND_MAX: usize = 120;
pub const FALL_MAX_ISLANDS: usize = 16;

// ---- the boss and its arena (F6, docs/briefs/fun7-boss.md) -------------------------------------------------

/// The Deep Mage's hp (design 1200; the balance commit sets the final number, see the F6 report).
pub const BOSS_HP: u16 = 800; // must equal the boss row of ENEMY_STATS (a test pins the client mirror)
/// Arena ellipse radii (cells) at size L; smaller worlds scale by the same percentage as the chambers, but never
/// below the minimums (the boss is 11 x 14 cells). The flat floor is `ry / 2` below the centre.
pub const ARENA_RX_L: i32 = 70;
pub const ARENA_RY_L: i32 = 40;
pub const ARENA_RX_MIN: i32 = 40;
pub const ARENA_RY_MIN: i32 = 24;
/// Liquids, gas, sand and gunpowder are cleared, and no other enemy is placed, inside the arena grown by this margin.
pub const ARENA_KEEP_OUT: i32 = 16;
/// The supply alcove beside the arena: width (cells beyond the rim) and height, and the spells piled in it
/// (one pickup each, 4 cells apart, nearest the arena first).
pub const SUPPLY_ALCOVE_W: i32 = 28;
pub const SUPPLY_ALCOVE_H: i32 = 8;
pub const SUPPLY_PILE: [u8; 6] = [4, 4, 4, 4, 5, 5];

/// Boss movement and attacks (F6). Attack cadences are stateless: an attack fires on the ticks where
/// `(tick + id) % period == offset` (and, for aimed ones, the line is clear), so the boss needs no timers.
/// Speed is in 1/16 cell per tick (phase 3 multiplies by 3/2); it closes in beyond `BOSS_CLOSE_CELLS`.
pub const BOSS_SPEED: i32 = 2;
pub const BOSS_AGGRO_CELLS: i32 = 200;
pub const BOSS_CLOSE_CELLS: i32 = 14;
pub const BOSS_FIRE_RANGE: i32 = 120;
/// Single Fire bolt in phases 1 and 2 every `BOSS_FIRE_TICKS`; a 3-bolt fan in phase 3 every `BOSS_FAN_TICKS`; the
/// fan's side bolts are the aim plus/minus the perpendicular times 1/`BOSS_FAN_SLOPE`.
pub const BOSS_FIRE_TICKS: u32 = 60;
pub const BOSS_FAN_TICKS: u32 = 90;
pub const BOSS_FAN_SLOPE: i32 = 4;
/// Phase 2+: a Bomb lob every `BOSS_BOMB_TICKS` (offset 30 into the period).
pub const BOSS_BOMB_TICKS: u32 = 120;
/// Phase 2+: every `BOSS_SUMMON_TICKS` (offset 150) up to `BOSS_SUMMON_PER_CAST` imps appear in the arena, at most
/// `BOSS_SUMMONS_ALIVE` alive at once and `BOSS_SUMMONS_TOTAL` in a whole fight. Each tries `BOSS_SUMMON_TRIES` cells.
pub const BOSS_SUMMON_TICKS: u32 = 300;
pub const BOSS_SUMMON_PER_CAST: usize = 2;
pub const BOSS_SUMMONS_ALIVE: usize = 4;
pub const BOSS_SUMMONS_TOTAL: u32 = 40;
pub const BOSS_SUMMON_TRIES: u32 = 8;
/// Phase 3: a lava arc of `BOSS_RING_CELLS` cells on the floor every `BOSS_RING_TICKS` (offset 60).
pub const BOSS_RING_CELLS: i32 = 24;
pub const BOSS_RING_TICKS: u32 = 240;
/// Phase thresholds in thirds of the boss's hp: above 2/3 is phase 1, above 1/3 phase 2, else 3.
/// The leash keeps the box's centre this many cells inside the ellipse.
pub const BOSS_LEASH_MARGIN: i32 = 8;
/// Ids stay below this (decode refuses more), so a summon's id never wraps u16.
pub const MAX_ENEMY_ID: u32 = 4096;
/// The boss starts with its feet this many cells above the arena floor.
pub const BOSS_HOVER: i32 = 8;
/// F6b: ticks every active player must stay ready before the round starts (3 s at `TICK_HZ` 60).
pub const LOBBY_COUNTDOWN_TICKS: u32 = 180;
/// `Sim::lobby_since` while no countdown is running.
pub const LOBBY_IDLE: u32 = u32::MAX;
/// F6b fix pass (S3): once a strict majority of the active players is ready, this many ticks (30 s) later the round
/// starts anyway and everyone not ready becomes a spectator. A shorter all-ready countdown still wins when it comes first.
pub const LOBBY_MAJORITY_TICKS: u32 = 1800;
/// Bytes of the round tail in the entity encoding: over, running, boss_killed, result, `lobby_since` u32 LE, `majority_since` u32 LE.
pub const ROUND_TAIL_BYTES: usize = 12;

/// Longest Paint stroke one input may draw, in cells along the longer axis (Chebyshev length). A stroke is a run of
/// disc stamps, one per cell of length, so this bounds the work every client does for one input: at most
/// `MAX_PAINT_STROKE + 1` stamps of at most (2 * MAX_PAINT_RADIUS + 1)^2 cells, about 0.5 M writes, down from 6.6 M for a
/// corner-to-corner stroke. `client/worker.ts` sends one segment per 33 ms (`SEND_EVERY_MS`) from the last sent point to the
/// latest pointer position, so a segment is the distance the pointer moved in one send interval. The canvas shows at
/// least 1 cell per 2 screen pixels, so 128 cells is 256+ px in 33 ms (above 7,700 px/s), faster than a real flick,
/// and only a stalled tab (several intervals batched) can exceed it. Normal painting is unchanged.
/// A too-long stroke is TRUNCATED from (x0, y0) along the same line, not dropped: the player still sees paint
/// where the stroke began, and the following segments (which start at their own anchors) carry on.
pub const MAX_PAINT_STROKE: i32 = 128;
