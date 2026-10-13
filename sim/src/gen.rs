//! World generation for `world_kind` 1 (plan 6.9, research/noita-caves.md section 4).
//!
//! Integer-only (clippy denies floats), no recursion, no `HashMap`. Every random draw is
//! `rng(seed, 0, x, y, SALT_GEN_*)` with a salt per use. The generator writes straight into the grid
//! without touching chunk metadata, so every chunk starts pristine.

use crate::grid::Grid;
use crate::materials::*;
use crate::rng::*;

pub const FLOOR_ROWS: usize = 64;
pub const WALL_COLS: usize = 16;
/// Mean surface height; the heightfield stays within about 200..260.
pub const SURFACE_Y: i32 = 230;
pub const SHALLOW_TOP: i32 = 260;
pub const DEEP_TOP: i32 = 800;

/// `smoothstep(i / 255)` in Q12 (0..=4096). Checked in, so no platform arithmetic can change it.
#[rustfmt::skip]
const SMOOTH: [u16; 256] = [
    0, 0, 1, 2, 3, 5, 7, 9, 12, 15, 18, 22, 26, 31, 36, 41,
    46, 52, 58, 65, 72, 79, 86, 94, 102, 110, 119, 128, 137, 147, 157, 167,
    177, 188, 199, 210, 222, 234, 246, 258, 271, 284, 297, 310, 324, 338, 352, 366,
    381, 396, 411, 426, 442, 457, 473, 489, 506, 522, 539, 556, 574, 591, 609, 627,
    645, 663, 681, 700, 718, 737, 757, 776, 795, 815, 835, 855, 875, 895, 915, 936,
    956, 977, 998, 1019, 1041, 1062, 1083, 1105, 1127, 1149, 1171, 1193, 1215, 1237, 1259, 1282,
    1304, 1327, 1350, 1373, 1396, 1419, 1442, 1465, 1488, 1512, 1535, 1558, 1582, 1605, 1629, 1653,
    1676, 1700, 1724, 1748, 1772, 1796, 1820, 1844, 1868, 1892, 1916, 1940, 1964, 1988, 2012, 2036,
    2060, 2084, 2108, 2132, 2156, 2180, 2204, 2228, 2252, 2276, 2300, 2324, 2348, 2372, 2396, 2420,
    2443, 2467, 2491, 2514, 2538, 2561, 2584, 2608, 2631, 2654, 2677, 2700, 2723, 2746, 2769, 2792,
    2814, 2837, 2859, 2881, 2903, 2925, 2947, 2969, 2991, 3013, 3034, 3055, 3077, 3098, 3119, 3140,
    3160, 3181, 3201, 3221, 3241, 3261, 3281, 3301, 3320, 3339, 3359, 3378, 3396, 3415, 3433, 3451,
    3469, 3487, 3505, 3522, 3540, 3557, 3574, 3590, 3607, 3623, 3639, 3654, 3670, 3685, 3700, 3715,
    3730, 3744, 3758, 3772, 3786, 3799, 3812, 3825, 3838, 3850, 3862, 3874, 3886, 3897, 3908, 3919,
    3929, 3939, 3949, 3959, 3968, 3977, 3986, 3994, 4002, 4010, 4017, 4024, 4031, 4038, 4044, 4050,
    4055, 4060, 4065, 4070, 4074, 4078, 4081, 4084, 4087, 4089, 4091, 4093, 4094, 4095, 4096, 4096
];

/// 2D value noise on a lattice of `wx` by `wy` cells; values are 0..=4095 (Q12).
pub struct Noise {
    wx: i32,
    wy: i32,
    gw: usize,
    vals: Vec<u16>,
}

impl Noise {
    pub fn new(seed: u64, salt: u32, wx: i32, wy: i32, w: i32, h: i32) -> Noise {
        let gw = (w / wx + 2) as usize;
        let gh = (h / wy + 2) as usize;
        let mut vals = Vec::with_capacity(gw * gh);
        for iy in 0..gh {
            for ix in 0..gw {
                vals.push((rng(seed, 0, ix as u32, iy as u32, salt) >> 20) as u16);
            }
        }
        Noise { wx, wy, gw, vals }
    }

    /// Interpolated value at (x, y), both within the extent given to `new`.
    pub fn at(&self, x: i32, y: i32) -> i32 {
        let (ix, fx) = ((x / self.wx) as usize, x % self.wx);
        let (iy, fy) = ((y / self.wy) as usize, y % self.wy);
        let sx = i32::from(SMOOTH[((fx * 255 + self.wx / 2) / self.wx) as usize]);
        let sy = i32::from(SMOOTH[((fy * 255 + self.wy / 2) / self.wy) as usize]);
        let v = |dx: usize, dy: usize| i32::from(self.vals[(iy + dy) * self.gw + ix + dx]);
        let top = v(0, 0) + (((v(1, 0) - v(0, 0)) * sx) >> 12);
        let bot = v(0, 1) + (((v(1, 1) - v(0, 1)) * sx) >> 12);
        top + (((bot - top) * sy) >> 12)
    }
}

pub struct Params {
    /// Open-cave thresholds in Q12 (a cell is open when the field is below it): shallow and deep.
    pub thr_shallow: i32,
    pub thr_deep: i32,
}

pub const PARAMS: Params = Params { thr_shallow: 1700, thr_deep: 1900 };

/// Surface height per column: three octaves of 1D value noise around `SURFACE_Y`.
fn surface_heights(seed: u64, w: i32, h: i32) -> Vec<i32> {
    let oct = [(256, 24, SALT_GEN_SURF_A), (64, 8, SALT_GEN_SURF_B), (16, 3, SALT_GEN_SURF_C)];
    let ns: Vec<Noise> = oct.iter().map(|&(wl, _, salt)| Noise::new(seed, salt, wl, 4096, w, h)).collect();
    (0..w)
        .map(|x| {
            let mut y = SURFACE_Y;
            for (n, &(_, amp, _)) in ns.iter().zip(&oct) {
                y += (n.at(x, 0) - 2048) * amp / 2048;
            }
            y
        })
        .collect()
}

/// The cave density field at quarter resolution, (w/4+1) x (h/4+1), one byte per sample (Q12 >> 4).
/// Domain-warped, two octaves, stretched horizontally.
fn cave_field(seed: u64, w: i32, h: i32) -> Vec<u8> {
    let n1 = Noise::new(seed, SALT_GEN_CAVE_A, 144, 96, w, h);
    let n2 = Noise::new(seed, SALT_GEN_CAVE_B, 48, 32, w, h);
    let wx = Noise::new(seed, SALT_GEN_WARP_X, 160, 160, w, h);
    let wy = Noise::new(seed, SALT_GEN_WARP_Y, 160, 160, w, h);
    let (qw, qh) = (w / 4 + 1, h / 4 + 1);
    let mut f = Vec::with_capacity((qw * qh) as usize);
    for qy in 0..qh {
        for qx in 0..qw {
            let (x, y) = ((qx * 4).min(w - 1), (qy * 4).min(h - 1));
            let sx = (x + (wx.at(x, y) - 2048) * 24 / 2048).clamp(0, w - 1);
            let sy = (y + (wy.at(x, y) - 2048) * 24 / 2048).clamp(0, h - 1);
            let v = (2 * n1.at(sx, sy) + n2.at(sx, sy)) / 3;
            f.push((v >> 4) as u8);
        }
    }
    f
}

/// Open threshold (Q12) at depth y: fades in below the surface cap, then eases from shallow to deep.
fn threshold(y: i32, surf: i32) -> i32 {
    let t = y.clamp(SHALLOW_TOP, DEEP_TOP) - SHALLOW_TOP;
    let base = PARAMS.thr_shallow + (PARAMS.thr_deep - PARAMS.thr_shallow) * t / (DEEP_TOP - SHALLOW_TOP);
    let below = y - surf;
    if below < 24 {
        0
    } else if below < 90 {
        base * (below - 24) / 66
    } else {
        base
    }
}

/// Generate a game world into an all-Empty grid.
pub fn generate(g: &mut Grid, seed: u64) {
    let (w, h) = (g.w as i32, g.h as i32);
    let surf = surface_heights(seed, w, h);
    fill_terrain(g, seed, &surf);
    carve_noise_caves(g, seed, &surf);
}

fn is_border(w: usize, h: usize, x: usize, y: usize) -> bool {
    y >= h - FLOOR_ROWS || x < WALL_COLS || x >= w - WALL_COLS
}

/// Sky above the surface, a few rows of Dirt, then Rock; Bedrock floor and side walls.
fn fill_terrain(g: &mut Grid, seed: u64, surf: &[i32]) {
    let (w, h) = (g.w, g.h);
    for (x, &s) in surf.iter().enumerate().take(w) {
        // Dirt depth 8..=12, varying by column.
        let dirt = 8 + (rng(seed, 0, x as u32, 0, SALT_GEN_DIRT) % 5) as i32;
        for y in 0..h {
            let m = if is_border(w, h, x, y) {
                BEDROCK
            } else if (y as i32) < s {
                EMPTY
            } else if (y as i32) < s + dirt {
                DIRT
            } else {
                ROCK
            };
            g.mat[y * w + x] = m;
        }
    }
}

/// Carve the density field into the solid ground. The quarter-resolution field is bilinearly
/// upsampled and a fine detail octave roughens the edges.
fn carve_noise_caves(g: &mut Grid, seed: u64, surf: &[i32]) {
    let (w, h) = (g.w as i32, g.h as i32);
    let f = cave_field(seed, w, h);
    let qw = (w / 4 + 1) as usize;
    let detail = Noise::new(seed, SALT_GEN_DETAIL, 8, 8, w, h);
    let (x_lo, x_hi) = (WALL_COLS as i32 + 8, w - WALL_COLS as i32 - 8);
    let y_hi = h - FLOOR_ROWS as i32 - 10;
    for y in 0..y_hi {
        let (qy, fy) = ((y >> 2) as usize, y & 3);
        for x in x_lo..x_hi {
            let i = (y * w + x) as usize;
            if g.mat[i] != ROCK && g.mat[i] != DIRT {
                continue;
            }
            let thr = threshold(y, surf[x as usize]);
            if thr == 0 {
                continue;
            }
            let (qx, fx) = ((x >> 2) as usize, x & 3);
            let a = i32::from(f[qy * qw + qx]);
            let b = i32::from(f[qy * qw + qx + 1]);
            let c = i32::from(f[(qy + 1) * qw + qx]);
            let d = i32::from(f[(qy + 1) * qw + qx + 1]);
            let top = a * (4 - fx) + b * fx;
            let bot = c * (4 - fx) + d * fx;
            // Samples are 0..=255 and the weights sum to 16, so this is Q12 (max 4080).
            let mut v = top * (4 - fy) + bot * fy;
            if (v - thr).abs() < 120 {
                v += (detail.at(x, y) - 2048) / 16;
            }
            if v < thr {
                g.mat[i] = EMPTY;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::Sim;

    #[test]
    fn generation_is_deterministic_and_seed_sensitive() {
        let a = Sim::new(7, 1).unwrap();
        let b = Sim::new(7, 1).unwrap();
        let c = Sim::new(8, 1).unwrap();
        assert!(a.grid.mat == b.grid.mat);
        assert!(a.grid.mat != c.grid.mat);
        assert!(a.grid.pristine.iter().all(|&p| p), "generation must leave every chunk pristine");
    }

    #[test]
    fn borders_surface_and_open_fraction() {
        let s = Sim::new(3, 1).unwrap();
        let g = &s.grid;
        for y in 0..g.h {
            for x in 0..g.w {
                if is_border(g.w, g.h, x, y) {
                    assert_eq!(g.mat[y * g.w + x], BEDROCK);
                }
            }
        }
        let top = |x: usize| (0..g.h).find(|&y| g.mat[y * g.w + x] != EMPTY).unwrap();
        for x in WALL_COLS + 1..g.w - WALL_COLS {
            assert!((190..=270).contains(&top(x)), "surface at x={x} is {}", top(x));
        }
        let shallow: Vec<u8> = (300..780).flat_map(|y| g.mat[y * g.w + 20..y * g.w + 2028].to_vec()).collect();
        let open = shallow.iter().filter(|&&m| m == EMPTY).count() * 100 / shallow.len();
        assert!((10..=40).contains(&open), "shallow band is {open}% open");
    }
}
