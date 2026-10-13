//! Material ids (plan 6.4).

pub const EMPTY: u8 = 0;
pub const BEDROCK: u8 = 1;
pub const ROCK: u8 = 2;
pub const DIRT: u8 = 3;
pub const SAND: u8 = 4;
pub const WATER: u8 = 5;
pub const WOOD: u8 = 6;
pub const SEED: u8 = 7;
pub const STEM: u8 = 8;
pub const FLOWER: u8 = 9;
pub const FIRE: u8 = 10;
pub const SMOKE: u8 = 11;
pub const STEAM: u8 = 12;
pub const GUNPOWDER: u8 = 13;
pub const LAVA: u8 = 14;

/// Materials that `Paint` may place: everything except Bedrock, the world boundary.
pub fn paintable(m: u8) -> bool {
    matches!(m, EMPTY | ROCK..=LAVA)
}

pub fn is_gas(m: u8) -> bool {
    matches!(m, FIRE | SMOKE | STEAM)
}

pub fn is_flammable(m: u8) -> bool {
    matches!(m, WOOD | SEED | STEM | FLOWER)
}
