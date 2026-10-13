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
