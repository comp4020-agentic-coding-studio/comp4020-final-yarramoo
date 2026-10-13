//! Material ids (plan 6.4). M0 implements 0-5 and 10 only.

pub const EMPTY: u8 = 0;
pub const BEDROCK: u8 = 1;
pub const ROCK: u8 = 2;
pub const DIRT: u8 = 3;
pub const SAND: u8 = 4;
pub const WATER: u8 = 5;
pub const FIRE: u8 = 10;

/// Materials that `Paint` may place in M0.
pub fn paintable(m: u8) -> bool {
    matches!(m, EMPTY | BEDROCK | ROCK | DIRT | SAND | WATER | FIRE)
}
