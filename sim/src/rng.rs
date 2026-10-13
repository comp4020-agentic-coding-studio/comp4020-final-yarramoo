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
pub const SALT_FIRE_IGNITE: u32 = 7;
pub const SALT_FIRE_SMOKE: u32 = 8;
pub const SALT_SMOKE_LIFE: u32 = 9;
pub const SALT_SMOKE_RISE: u32 = 10;
pub const SALT_SMOKE_DIR: u32 = 11;
pub const SALT_STEAM_LIFE: u32 = 12;
pub const SALT_STEAM_RISE: u32 = 13;
pub const SALT_STEAM_DIR: u32 = 14;
pub const SALT_SEED_DIAG: u32 = 15;
pub const SALT_SEED_GERM: u32 = 16;
pub const SALT_SEED_HEIGHT: u32 = 17;
pub const SALT_STEM_GROW: u32 = 18;
pub const SALT_GUNPOWDER_DIAG: u32 = 19;
pub const SALT_BLAST_RIM: u32 = 20;
pub const SALT_LAVA_DIAG: u32 = 21;
pub const SALT_LAVA_SIDE: u32 = 22;
pub const SALT_LAVA_IGNITE: u32 = 23;

pub const SALT_GEN_SURF_A: u32 = 100;
pub const SALT_GEN_SURF_B: u32 = 101;
pub const SALT_GEN_SURF_C: u32 = 102;
pub const SALT_GEN_DIRT: u32 = 103;
pub const SALT_GEN_CAVE_A: u32 = 104;
pub const SALT_GEN_CAVE_B: u32 = 105;
pub const SALT_GEN_WARP_X: u32 = 106;
pub const SALT_GEN_WARP_Y: u32 = 107;
pub const SALT_GEN_DETAIL: u32 = 108;
pub const SALT_GEN_ENTRANCE: u32 = 109;
pub const SALT_GEN_WORM_DY: u32 = 110;
pub const SALT_GEN_WORM_DX: u32 = 111;
pub const SALT_GEN_WORM_R: u32 = 112;
pub const SALT_GEN_WORM_DRIFT: u32 = 113;
pub const SALT_GEN_WORM_BRANCH: u32 = 114;
pub const SALT_GEN_HWORM: u32 = 115;

pub const SALT_GEN_DIRTLINE: u32 = 116;
pub const SALT_GEN_SAND_X: u32 = 117;
pub const SALT_GEN_SAND_Y: u32 = 118;
pub const SALT_GEN_SAND_R: u32 = 119;
pub const SALT_GEN_GP_X: u32 = 120;
pub const SALT_GEN_GP_Y: u32 = 121;
pub const SALT_GEN_GP_R: u32 = 122;
pub const SALT_GEN_WATER_X: u32 = 123;
pub const SALT_GEN_WATER_Y: u32 = 124;
pub const SALT_GEN_WATER_D: u32 = 125;
pub const SALT_GEN_LAVA_X: u32 = 126;
pub const SALT_GEN_LAVA_Y: u32 = 127;
pub const SALT_GEN_LAVA_D: u32 = 128;
pub const SALT_GEN_TREE_X: u32 = 129;
pub const SALT_GEN_TREE_H: u32 = 130;
pub const SALT_GEN_TREE_BR: u32 = 131;
pub const SALT_GEN_SPOT_X: u32 = 132;
pub const SALT_GEN_SPOT_Y: u32 = 133;
pub const SALT_GEN_LINK: u32 = 134;

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
