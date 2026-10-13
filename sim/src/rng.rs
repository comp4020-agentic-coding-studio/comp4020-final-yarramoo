//! Counter-based RNG (plan 6.3). There is no stateful RNG.

pub fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

pub fn rng(seed: u64, tick: u32, x: u32, y: u32, salt: u32) -> u32 {
    (mix(seed ^ mix(tick as u64 | ((salt as u64) << 32)) ^ mix(((x as u64) << 32) | y as u64)) >> 32)
        as u32
}

/// One distinct salt per use of randomness.
pub const SALT_SAND_DIAG: u32 = 1;
pub const SALT_WATER_DIAG: u32 = 2;
pub const SALT_WATER_SIDE: u32 = 3;
pub const SALT_FIRE_LIFE: u32 = 4;
pub const SALT_FIRE_RISE: u32 = 5;
pub const SALT_FIRE_DIR: u32 = 6;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_sensitive() {
        assert_eq!(rng(1, 2, 3, 4, 5), rng(1, 2, 3, 4, 5));
        let base = rng(1, 2, 3, 4, 5);
        assert_ne!(base, rng(2, 2, 3, 4, 5));
        assert_ne!(base, rng(1, 3, 3, 4, 5));
        assert_ne!(base, rng(1, 2, 4, 4, 5));
        assert_ne!(base, rng(1, 2, 3, 5, 5));
        assert_ne!(base, rng(1, 2, 3, 4, 6));
    }

    #[test]
    fn mix_known_value() {
        // splitmix64 finaliser of 0 is 0; of 1 is a fixed constant.
        assert_eq!(mix(0), 0);
        assert_eq!(mix(1), 0x5692161d100b05e5);
    }
}
