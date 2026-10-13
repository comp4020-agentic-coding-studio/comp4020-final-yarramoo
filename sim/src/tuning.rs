//! Gameplay constants (plan 6.6, 6.7). All integers; one place so balance changes never touch logic.

/// Spell ids: 0 Push, 1 Blast, 2 Water, 3 Rose seed, 4 Fire bolt, 5 Bomb (plan 6.7).
pub const NUM_SPELLS: usize = 6;
/// Infinite charges (the starter spells).
pub const INFINITE: u16 = u16::MAX;
/// Charges a player starts with, per spell: Push and Blast are infinite.
pub const START_CHARGES: [u16; NUM_SPELLS] = [INFINITE, INFINITE, 0, 0, 0, 0];
/// Charges one pickup of each spell grants (plan 6.7).
pub const PICKUP_CHARGES: [u16; NUM_SPELLS] = [0, 0, 15, 15, 10, 5];
/// Ticks before a collected pickup is available again (plan 14: 60 s).
pub const PICKUP_RESPAWN: u32 = 3600;

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

/// Spells the sim implements so far; Fire bolt and Bomb arrive with M5 (their casts are refused).
pub const SPELL_ENABLED: [bool; NUM_SPELLS] = [true, true, true, true, false, false];
/// Ticks between casts of the same spell.
pub const COOLDOWN: [u32; NUM_SPELLS] = [20, 90, 10, 10, 15, 60];
/// Launch speed, 1/256 cell per tick (Push 5 cells a tick; Water and Rose are lobbed slower).
pub const SPEED: [i32; NUM_SPELLS] = [1280, 0, 768, 768, 896, 640];
/// Downward acceleration, 1/256 cell per tick per tick.
pub const GRAVITY_Q8: [i32; NUM_SPELLS] = [0, 0, 10, 10, 4, 20];
/// Knockback impulses in 1/16 cell per tick (plan 6.7).
pub const KNOCK_PUSH: i32 = 64;
pub const KNOCK_BLAST: i32 = 96;
/// Blast reach in cells, and the half-angle of its cone: 45 degrees (the test is `2 * dot^2 >= |d|^2`).
pub const BLAST_RADIUS_CELLS: i32 = 24;
/// Height of a player's chest above the feet, in cells: where bolts leave and what the cone aims at.
pub const CHEST: i32 = 5;
pub const WATER_BURST_CELLS: usize = 60;
/// Squared radius (cells) of the disc a water burst fills, in Empty cells only.
pub const WATER_BURST_R2: i32 = 36;
pub const SEED_BURST_CELLS: u32 = 8;
pub const SEED_BURST_R: u32 = 3;
