//! The room config (plan-game-modes.md "Config fields"): a fixed 16-byte, integers-only description of a room's
//! terrain, size and rules. The sim reads it once at `init`; it is stored in the snapshot header and covered by
//! the state hash, so two clients with different configs diverge at the first hash check.
//!
//! Layout (version 1), one byte each:
//! `version, terrain, size, avatars, damage, spells, brushes, death, respawn_secs, pickup_respawn, round,
//! max_players, reserved x4` (reserved bytes must be zero). `shared/room.ts` mirrors this table.
//!
//! Every rule gate in the sim goes through a helper here, never a bare field compare, so the meaning of a
//! gate lives in one place.

pub const CONFIG_BYTES: usize = 16;
pub const CONFIG_VERSION: u8 = 1;

pub const TERRAIN_CAVES: u8 = 0;
pub const TERRAIN_SOLID_BOX: u8 = 1;
pub const TERRAIN_EMPTY_BOX: u8 = 2;

/// `size` 0..=2 to cells. Size S is 512x512 for now, so the classic sandbox stays byte-for-byte what it was
/// (the plan's 512x384 is R1's call, with the terrain work).
pub const SIZES: [(usize, usize); 3] = [(512, 512), (1024, 768), (2048, 1536)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoomConfig {
    pub terrain: u8,
    pub size: u8,
    pub avatars: u8,
    pub damage: u8,
    pub spells: u8,
    pub brushes: u8,
    pub death: u8,
    pub respawn_secs: u8,
    pub pickup_respawn: u8,
    pub round: u8,
    pub max_players: u8,
}

impl RoomConfig {
    /// Today's world 0: an empty walled canvas, painting only, no avatars.
    pub const fn classic_sandbox() -> RoomConfig {
        RoomConfig { terrain: TERRAIN_EMPTY_BOX, size: 0, avatars: 0, damage: 0, spells: 0, brushes: 1, death: 0, respawn_secs: 0, pickup_respawn: 0, round: 0, max_players: 8 }
    }

    /// Today's world 1: the caves, avatars, full PvP, spells from pickups, respawn after 3 s (DEATH_TICKS).
    pub const fn caves_pvp() -> RoomConfig {
        RoomConfig { terrain: TERRAIN_CAVES, size: 2, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 0, respawn_secs: 3, pickup_respawn: 1, round: 0, max_players: 8 }
    }

    pub fn encode(&self) -> [u8; CONFIG_BYTES] {
        let mut b = [0u8; CONFIG_BYTES];
        b[..12].copy_from_slice(&[
            CONFIG_VERSION, self.terrain, self.size, self.avatars, self.damage, self.spells, self.brushes, self.death,
            self.respawn_secs, self.pickup_respawn, self.round, self.max_players,
        ]);
        b
    }

    /// None for a wrong length or version, a non-zero reserved byte, or any out-of-range field. Nothing is clamped.
    pub fn decode(b: &[u8]) -> Option<RoomConfig> {
        if b.len() != CONFIG_BYTES || b[0] != CONFIG_VERSION || b[12..].iter().any(|&x| x != 0) {
            return None;
        }
        let c = RoomConfig {
            terrain: b[1], size: b[2], avatars: b[3], damage: b[4], spells: b[5], brushes: b[6], death: b[7],
            respawn_secs: b[8], pickup_respawn: b[9], round: b[10], max_players: b[11],
        };
        let ok = c.terrain <= 2
            && c.size <= 2
            && c.avatars <= 1
            && c.damage <= 2
            && c.spells <= 1
            && c.brushes <= 1
            && c.death <= 1
            && c.respawn_secs <= 30
            && c.pickup_respawn <= 1
            && c.round <= 1
            && (c.round == 0 || c.death == 1)
            && (2..=8).contains(&c.max_players);
        ok.then_some(c)
    }

    /// Avatars exist: Join, Pos and Cast act, and the world has entities, explosions and hazards.
    pub fn has_players(&self) -> bool {
        self.avatars == 1
    }
    pub fn damage_from_players(&self) -> bool {
        self.damage == 2
    }
    pub fn damage_from_env(&self) -> bool {
        self.damage >= 1
    }
    /// Paint inputs act (the brush panel). The `dev_paint` feature overrides this in `Sim::apply`.
    pub fn paint_allowed(&self) -> bool {
        self.brushes == 1
    }
    /// Every spell with unlimited charges (Creative).
    pub fn all_spells(&self) -> bool {
        self.spells == 1
    }
    pub fn dims(&self) -> (usize, usize) {
        SIZES[usize::from(self.size.min(2))]
    }
    /// Caves are generated (gen v1 is 2048x1536 only, so only size L); the pristine world is cacheable.
    pub fn is_caves(&self) -> bool {
        self.terrain == TERRAIN_CAVES
    }
}

/// What `Sim::new` accepts: a config, or (for the many existing tests and examples, and the determinism script
/// aliases) the old world kind 0 or 1, which maps to its preset. Anything else is None.
pub trait IntoRoom {
    fn into_room(self) -> Option<RoomConfig>;
}
impl IntoRoom for RoomConfig {
    fn into_room(self) -> Option<RoomConfig> {
        Some(self)
    }
}
impl IntoRoom for &RoomConfig {
    fn into_room(self) -> Option<RoomConfig> {
        Some(*self)
    }
}
impl IntoRoom for u8 {
    fn into_room(self) -> Option<RoomConfig> {
        match self {
            0 => Some(RoomConfig::classic_sandbox()),
            1 => Some(RoomConfig::caves_pvp()),
            _ => None,
        }
    }
}
