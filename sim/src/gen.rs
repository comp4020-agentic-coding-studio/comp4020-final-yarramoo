//! World generation for `world_kind` 1 (plan 6.9, research/noita-caves.md section 4).
//!
//! Integer-only (clippy denies floats), no recursion, no `HashMap`. Every random draw is
//! `rng(seed, 0, x, y, SALT_GEN_*)` with a salt per use. The generator writes straight into the grid
//! without touching chunk metadata, so every chunk starts pristine.
#![allow(clippy::manual_is_multiple_of, clippy::needless_range_loop, clippy::too_many_arguments)]

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

pub const PARAMS: Params = Params { thr_shallow: 1250, thr_deep: 1500 };

/// Surface height per column: three octaves of 1D value noise around `surface_y` (L's `SURFACE_Y`,
/// scaled; see `Scale`). The undulation amplitudes scale with it too, so a shorter world's surface band
/// stays a similar fraction of its depth instead of swallowing the shallow band.
fn surface_heights(seed: u64, w: i32, h: i32, surface_y: i32) -> Vec<i32> {
    let oct = [(256, 24, SALT_GEN_SURF_A), (64, 8, SALT_GEN_SURF_B), (16, 3, SALT_GEN_SURF_C)];
    let ns: Vec<Noise> = oct.iter().map(|&(wl, _, salt)| Noise::new(seed, salt, wl, 4096, w, h)).collect();
    (0..w)
        .map(|x| {
            let mut y = surface_y;
            for (n, &(_, amp, _)) in ns.iter().zip(&oct) {
                let amp = (amp * surface_y / SURFACE_Y).max(1);
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
/// `shallow`/`deep` are the per-size scaled band tops (`Scale::shallow_top`/`deep_top`): at L they equal
/// the module `SHALLOW_TOP`/`DEEP_TOP` exactly.
fn threshold(y: i32, surf: i32, shallow: i32, deep: i32) -> i32 {
    let t = y.clamp(shallow, deep) - shallow;
    let base = PARAMS.thr_shallow + (PARAMS.thr_deep - PARAMS.thr_shallow) * t / (deep - shallow).max(1);
    let below = y - surf;
    if below < 24 {
        0
    } else if below < 90 {
        base * (below - 24) / 66
    } else {
        base
    }
}

/// Scale a value tuned for L's usable height (1536 rows minus the `FLOOR_ROWS` floor, i.e. 1472 rows of
/// diggable depth) to another world's usable height. Exact at L: `h - FLOOR_ROWS == 1472` there, so this
/// returns `v` unchanged (the brief's "byte-identical presets" requirement for `caves_pvp`).
fn scale_u(h: i32, v: i32) -> i32 {
    v * (h - FLOOR_ROWS as i32) / (1536 - FLOOR_ROWS as i32)
}

/// The traversal test's per-size target depth (L's 1380, scaled): exposed so the test derives it the same
/// way the generator does, rather than duplicating the ratio. Test-only (`cfg(test)`), so it never ships
/// in `sim.wasm`.
#[cfg(test)]
pub(crate) fn traversal_target_for(h: i32) -> i32 {
    scale_u(h, 1380)
}

/// Scale a target count (pickup spots, material piles/trees) by this world's area relative to L's, with a
/// floor so a small world still gets a sensible minimum. Exact at L (area ratio is 1).
fn scale_count(w: i32, h: i32, v: i32, floor: i32) -> i32 {
    let area = i64::from(w) * i64::from(h);
    let base = 2048i64 * 1536i64;
    ((i64::from(v) * area / base) as i32).max(floor)
}

/// Per-size tuning derived once per `generate` call, so Caves at S and M keep the same guarantees as L (a
/// walkable body, materials that respect the depth bands) without baking L's absolute row/column numbers
/// into a much shorter or narrower world. Every field is exact at L (w=2048, h=1536): `scale_u`/
/// `scale_count` return their input unchanged there.
struct Scale {
    surface_y: i32,
    shallow_top: i32,
    deep_top: i32,
    repair_depth: i32,
    link_rows: [i32; 7],
    sand_y_lo: i32,
    sand_y_span: i32,
    sand_count: i32,
    sand_x_span: i32,
    gp_y_lo: i32,
    gp_y_span: i32,
    gp_count: i32,
    water_y_lo: i32,
    water_y_span: i32,
    water_count: i32,
    water_x_span: i32,
    lava_y_lo: i32,
    lava_y_span: i32,
    lava_count: i32,
    tree_count: i32,
    worm_target_y: i32,
    worm_branch_span: i32,
    link_x_span: i32,
    target_spots: [(i32, i32, i32); 2],
    /// Worm radii (min, max, start), cells: roomy tunnels, two to three bodies tall at L, scaled down on small worlds.
    worm_r: (i32, i32, i32),
}

impl Scale {
    fn new(w: i32, h: i32) -> Scale {
        let surface_y = scale_u(h, SURFACE_Y);
        let shallow_top = scale_u(h, SHALLOW_TOP);
        let deep_top = scale_u(h, DEEP_TOP);
        let worm_target_y = deep_top + 100;
        // 100% at L (2048 wide), 80% at M, 60% at S, so a small world is not solid tunnel.
        let pct = (60 + 40 * (w - 512) / (2048 - 512)).clamp(60, 100);
        let wr = |v: i32| (v * pct / 100).max(5);
        Scale {
            surface_y,
            shallow_top,
            deep_top,
            repair_depth: scale_u(h, 1420),
            link_rows: [380, 520, 660, 900, 1060, 1200, 1320].map(|v| scale_u(h, v)),
            sand_y_lo: shallow_top + 20,
            sand_y_span: scale_u(h, 500).max(40),
            sand_count: scale_count(w, h, 40, 6),
            sand_x_span: (w - 118).max(40),
            gp_y_lo: deep_top + 20,
            gp_y_span: scale_u(h, 600).max(40),
            gp_count: scale_count(w, h, 45, 8),
            water_y_lo: shallow_top + 20,
            water_y_span: scale_u(h, 480).max(40),
            water_count: scale_count(w, h, 90, 10),
            water_x_span: (w - 88).max(40),
            lava_y_lo: deep_top + 60,
            lava_y_span: scale_u(h, 520).max(40),
            lava_count: scale_count(w, h, 40, 6),
            tree_count: scale_count(w, h, 28, 4),
            worm_target_y,
            worm_branch_span: scale_u(h, 450).max(60),
            link_x_span: (w - 348).max(40),
            worm_r: (wr(WORM_R_MIN), wr(WORM_R_MAX), wr(WORM_R_START)),
            target_spots: [
                (shallow_top + 40, deep_top - 40, scale_count(w, h, 40, 8)),
                (deep_top + 40, scale_u(h, 1400), scale_count(w, h, 25, 6)),
            ],
        }
    }
}

/// Generate a game world into an all-Empty grid.
pub fn generate(g: &mut Grid, seed: u64) -> Vec<PickupSpot> {
    let (w, h) = (g.w as i32, g.h as i32);
    let sc = Scale::new(w, h);
    let surf = surface_heights(seed, w, h, sc.surface_y);
    fill_terrain(g, seed, &surf);
    carve_noise_caves(g, seed, &surf, &sc);
    let mut path = Vec::new();
    carve_worms(g, seed, &surf, &mut path, &sc);
    connect_and_prune(g, seed, &path);
    line_entrances_with_dirt(g, seed, &surf);
    let mut pool_scratch = PoolScratch { mark: vec![0u8; g.mat.len()], stack: Vec::new(), region: Vec::new() };
    place_sand(g, seed, &sc);
    place_lava(g, seed, &mut pool_scratch, &sc);
    place_gunpowder(g, seed, &sc);
    place_water(g, seed, &mut pool_scratch, &sc);
    place_trees(g, seed, &surf, &sc);
    repair_traversal(g, seed, &sc);
    pick_spots(g, seed, &sc)
}

/// A floor position where M4 can place a pickup: an Empty cell with solid ground below and headroom.
/// `Sim::new` turns each spot into a pickup entity (state); the spot itself is not kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickupSpot {
    pub x: u16,
    pub y: u16,
    /// 0 = shallow band, 1 = deep band.
    pub band: u8,
}

fn solid_ground(m: u8) -> bool {
    matches!(m, ROCK | DIRT | BEDROCK | SAND)
}

/// Starting at (x, y0): skip down to the first Empty cell (within 60 rows), then fall to the floor
/// (within `max_down` rows). Returns the Empty cell resting on Rock/Dirt/Sand/Bedrock.
fn find_floor(g: &Grid, x: i32, y0: i32, max_down: i32) -> Option<i32> {
    let (w, h) = (g.w as i32, g.h as i32);
    if x < 0 || x >= w {
        return None;
    }
    let at = |y: i32| g.mat[(y * w + x) as usize];
    let mut y = y0.clamp(0, h - 2);
    let lim = y + 60;
    while at(y) != EMPTY {
        y += 1;
        if y >= h - 1 || y > lim {
            return None;
        }
    }
    let end = (y + max_down).min(h - 2);
    while y < end && at(y + 1) == EMPTY {
        y += 1;
    }
    solid_ground(at(y + 1)).then_some(y)
}

/// Below the surface, most of the top 40 rows are Dirt, so shafts open through a soil layer.
fn line_entrances_with_dirt(g: &mut Grid, seed: u64, surf: &[i32]) {
    let w = g.w;
    for x in WALL_COLS..w - WALL_COLS {
        let s = surf[x];
        for y in s + 8..s + 40 {
            let i = y as usize * w + x;
            if g.mat[i] == ROCK && rng(seed, 0, x as u32, y as u32, SALT_GEN_DIRTLINE) % 5 != 0 {
                g.mat[i] = DIRT;
            }
        }
    }
}

/// Fill a mound of `mat` on the floors under a blob: each column rises by `(r - |dx|) / div + 1`.
fn pile(g: &mut Grid, cx: i32, y_ref: i32, r: i32, div: i32, mat: u8) -> usize {
    let w = g.w as i32;
    let mut put = 0;
    for x in cx - r..=cx + r {
        let Some(yf) = find_floor(g, x, y_ref - 10, 40) else { continue };
        let depth = (r - (x - cx).abs()) / div + 1;
        for k in 0..depth {
            let i = ((yf - k) * w + x) as usize;
            if g.mat[i] != EMPTY || (mat == GUNPOWDER && near_material(g, x, yf - k, 9, 9, LAVA)) {
                break;
            }
            g.mat[i] = mat;
            put += 1;
        }
    }
    put
}

fn place_sand(g: &mut Grid, seed: u64, sc: &Scale) {
    for k in 0..sc.sand_count as u32 {
        let x = 60 + (rng(seed, 0, k, 0, SALT_GEN_SAND_X) % sc.sand_x_span as u32) as i32;
        let y = sc.sand_y_lo + (rng(seed, 0, k, 0, SALT_GEN_SAND_Y) % sc.sand_y_span as u32) as i32;
        let r = 12 + (rng(seed, 0, k, 0, SALT_GEN_SAND_R) % 19) as i32;
        pile(g, x, y, r, 3, SAND);
    }
}

fn near_material(g: &Grid, cx: i32, cy: i32, rx: i32, ry: i32, m: u8) -> bool {
    let (w, h) = (g.w as i32, g.h as i32);
    for y in (cy - ry).max(0)..=(cy + ry).min(h - 1) {
        for x in (cx - rx).max(0)..=(cx + rx).min(w - 1) {
            if g.mat[(y * w + x) as usize] == m {
                return true;
            }
        }
    }
    false
}

fn place_gunpowder(g: &mut Grid, seed: u64, sc: &Scale) {
    let mut placed = 0;
    for k in 0..3000u32 {
        if placed == sc.gp_count {
            break;
        }
        let x = 60 + (rng(seed, 0, k, 0, SALT_GEN_GP_X) % sc.sand_x_span as u32) as i32;
        let y = sc.gp_y_lo + (rng(seed, 0, k, 0, SALT_GEN_GP_Y) % sc.gp_y_span as u32) as i32;
        let r = 6 + (rng(seed, 0, k, 0, SALT_GEN_GP_R) % 9) as i32;
        // Keep 8 cells clear of lava over the whole area the pile could touch.
        if near_material(g, x, y + 15, r + 8 + 2, 60, LAVA) {
            continue;
        }
        // Count only piles that landed, so a sparser cave system still gets its pockets.
        if pile(g, x, y, r, 2, GUNPOWDER) >= 20 {
            placed += 1;
        }
    }
}

/// Level fill: every Empty cell connected to (x, yf) at or below row `ly`, up to `cap` cells.
/// By construction the region is closed below the level (any Empty neighbour is in it), so a liquid
/// filling it has a flat top at `ly` and nowhere to fall. Returns false if it exceeds `cap`.
fn level_flood(g: &Grid, mark: &mut [u8], stack: &mut Vec<u32>, region: &mut Vec<u32>, x: i32, yf: i32, ly: i32, cap: usize) -> bool {
    let (w, h) = (g.w, g.h);
    region.clear();
    stack.clear();
    let start = yf as usize * w + x as usize;
    mark[start] = 1;
    stack.push(start as u32);
    let mut ok = true;
    while let Some(c) = stack.pop() {
        let i = c as usize;
        region.push(c);
        if region.len() > cap {
            ok = false;
            break;
        }
        let (cx, cy) = (i % w, i / w);
        let mut visit = |j: usize| {
            if g.mat[j] == EMPTY && mark[j] == 0 {
                mark[j] = 1;
                stack.push(j as u32);
            }
        };
        if cx > 0 {
            visit(i - 1);
        }
        if cx + 1 < w {
            visit(i + 1);
        }
        if cy > 0 && (cy - 1) as i32 >= ly {
            visit(i - w);
        }
        if cy + 1 < h {
            visit(i + w);
        }
    }
    // Everything marked (region plus anything still on the stack) must be unmarked again.
    for &c in region.iter().chain(stack.iter()) {
        mark[c as usize] = 0;
    }
    ok
}

struct PoolScratch {
    mark: Vec<u8>,
    stack: Vec<u32>,
    region: Vec<u32>,
}

/// Try a pool of up to `max_depth` rows resting on the floor at (x, yf): the deepest level whose basin
/// stays under `cap` cells. `foe` is a liquid that must not touch it.
fn try_pool(g: &mut Grid, sc: &mut PoolScratch, x: i32, yf: i32, depths: (i32, i32), cap: usize, mat: u8, foe: u8) -> bool {
    let w = g.w;
    // Deepest first; a basin that overflows `cap` at one level may fit at a shallower one.
    for d in (depths.0..=depths.1).rev() {
        let ly = yf - d + 1;
        if ly < 1 || !level_flood(g, &mut sc.mark, &mut sc.stack, &mut sc.region, x, yf, ly, cap) {
            continue;
        }
        // A pool is a pond in a basin, not a river along a tunnel: bound its width, and keep it in its band.
        let (mut lo, mut hi, mut lowest) = (usize::MAX, 0usize, 0usize);
        for &c in &sc.region {
            let (cx, cy) = (c as usize % w, c as usize / w);
            lo = lo.min(cx);
            hi = hi.max(cx);
            lowest = lowest.max(cy);
        }
        if hi - lo > 70 || (mat == WATER && lowest >= DEEP_TOP as usize - 4) {
            continue;
        }
        let touches = sc.region.iter().any(|&c| {
            let i = c as usize;
            [i - 1, i + 1, i - w, i + w].iter().any(|&j| g.mat[j] == foe)
        });
        if touches {
            return false;
        }
        for &c in &sc.region {
            g.mat[c as usize] = mat;
        }
        return true;
    }
    false
}

fn place_water(g: &mut Grid, seed: u64, sc: &mut PoolScratch, scale: &Scale) {
    let mut placed = 0;
    for k in 0..1500u32 {
        if placed == scale.water_count {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_WATER_X) % scale.water_x_span as u32) as i32;
        let y = scale.water_y_lo + (rng(seed, 0, k, 0, SALT_GEN_WATER_Y) % scale.water_y_span as u32) as i32;
        let depth = 5 + (rng(seed, 0, k, 0, SALT_GEN_WATER_D) % 10) as i32;
        let Some(yf) = find_floor(g, x, y, 120) else { continue };
        if yf >= scale.deep_top - 12 || g.mat[yf as usize * g.w + x as usize] != EMPTY {
            continue;
        }
        if try_pool(g, sc, x, yf, (3, depth), 900, WATER, LAVA) {
            placed += 1;
        }
    }
}

fn place_lava(g: &mut Grid, seed: u64, sc: &mut PoolScratch, scale: &Scale) {
    let w = g.w as i32;
    let mut placed = 0;
    for k in 0..1500u32 {
        if placed == scale.lava_count {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_LAVA_X) % scale.water_x_span as u32) as i32;
        let y = scale.lava_y_lo + (rng(seed, 0, k, 0, SALT_GEN_LAVA_Y) % scale.lava_y_span as u32) as i32;
        let depth = 8 + (rng(seed, 0, k, 0, SALT_GEN_LAVA_D) % 13) as i32;
        let Some(yf) = find_floor(g, x, y, 160) else { continue };
        if yf < scale.deep_top + 30 || g.mat[(yf * w + x) as usize] != EMPTY {
            continue;
        }
        if try_pool(g, sc, x, yf, (4, depth), 1800, LAVA, WATER) {
            // A 2-cell Rock lining under the pool, so it cannot meet other liquids from below.
            for &c in &sc.region {
                let i = c as usize;
                for dy in 1..=2 {
                    let j = i + dy * g.w;
                    if matches!(g.mat[j], DIRT | SAND) {
                        g.mat[j] = ROCK;
                    }
                }
            }
            placed += 1;
        }
    }
}

/// Wood trees on the Dirt surface: a trunk, two short branches.
fn place_trees(g: &mut Grid, seed: u64, surf: &[i32], sc: &Scale) {
    let w = g.w as i32;
    let mut xs: Vec<i32> = Vec::new();
    for k in 0..(sc.tree_count * 5).max(120) as u32 {
        if xs.len() == sc.tree_count as usize {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_TREE_X) % sc.water_x_span as u32) as i32;
        let (s0, s1) = (surf[x as usize], surf[x as usize + 1]);
        if (s0 - s1).abs() > 1 || xs.iter().any(|&o| (o - x).abs() < 24) {
            continue;
        }
        // Skip entrance shafts: the ground below the surface cell must be solid.
        if g.mat[((s0 + 2) * w + x) as usize] != DIRT || g.mat[((s1 + 2) * w + x + 1) as usize] != DIRT {
            continue;
        }
        let hgt = 14 + (rng(seed, 0, k, 0, SALT_GEN_TREE_H) % 16) as i32;
        for dy in -2..hgt {
            for dx in 0..2 {
                let i = ((s0.min(s1) - dy) * w + x + dx) as usize;
                if g.mat[i] == EMPTY || g.mat[i] == DIRT {
                    g.mat[i] = WOOD;
                }
            }
        }
        for b in 0..2u32 {
            let side = if rng(seed, 0, k, b, SALT_GEN_TREE_BR) & 1 == 0 { -1 } else { 1 };
            let by = s0.min(s1) - hgt / 2 - (rng(seed, 0, k, b + 2, SALT_GEN_TREE_BR) % 6) as i32 - b as i32 * 3;
            let len = 5 + (rng(seed, 0, k, b + 4, SALT_GEN_TREE_BR) % 5) as i32;
            for j in 1..=len {
                let (bx, byy) = (x + if side < 0 { -j } else { j + 1 }, by - j / 2);
                let i = (byy * w + bx) as usize;
                if g.mat[i] == EMPTY {
                    g.mat[i] = WOOD;
                }
            }
        }
        xs.push(x);
    }
}

/// Floor positions for pickups: about 40 in the shallow band, 25 in the deep, at least 40 apart.
fn pick_spots(g: &Grid, seed: u64, sc: &Scale) -> Vec<PickupSpot> {
    let w = g.w as i32;
    let mut out: Vec<PickupSpot> = Vec::new();
    for (band, &(y_lo, y_hi, want)) in sc.target_spots.iter().enumerate() {
        let mut n = 0;
        // 4000 tries, not 400: sparse deep caves need the room to find every spot (D-086).
        for k in 0..4000u32 {
            if n == want {
                break;
            }
            let x = 40 + (rng(seed, 0, k, band as u32, SALT_GEN_SPOT_X) % sc.water_x_span as u32) as i32;
            let y = y_lo + (rng(seed, 0, k, band as u32, SALT_GEN_SPOT_Y) % (y_hi - y_lo) as u32) as i32;
            let Some(yf) = find_floor(g, x, y, 100) else { continue };
            if yf < y_lo || yf > y_hi || g.mat[((yf + 1) * w + x) as usize] == SAND {
                continue;
            }
            // Headroom: 8 Empty cells straight up, so an avatar fits.
            if (1..=8).any(|d| g.mat[((yf - d) * w + x) as usize] != EMPTY) {
                continue;
            }
            if out.iter().any(|s| (i32::from(s.x) - x).abs() < 40 && (i32::from(s.y) - yf).abs() < 40) {
                continue;
            }
            out.push(PickupSpot { x: x as u16, y: yf as u16, band: band as u8 });
            n += 1;
        }
    }
    out
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
fn carve_noise_caves(g: &mut Grid, seed: u64, surf: &[i32], sc: &Scale) {
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
            let thr = threshold(y, surf[x as usize], sc.shallow_top, sc.deep_top);
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
            if (v - thr).abs() < 40 {
                v += (detail.at(x, y) - 2048) / 16;
            }
            if v < thr {
                g.mat[i] = EMPTY;
            }
        }
    }
}

/// A tunnel digger. Its randomness is `rng(seed, 0, id, step, SALT_GEN_*)`, so a worm is a pure
/// function of (seed, id) and does not depend on the order other worms run in.
struct Worm {
    id: u32,
    x: i32,
    y: i32,
    r: i32,
    r_min: i32,
    r_max: i32,
    drift: i32,
    step: u32,
    max_steps: u32,
    target_y: i32,
    branches: u8,
    /// Sideways push added to a branch's first 200 steps, so it leaves its parent at an angle.
    lean: i32,
    /// Horizontal link worm: heading (+1/-1) and the row it wanders around.
    horiz: Option<(i32, i32)>,
}

/// Remove Rock and Dirt in a disc; Bedrock and everything else stays.
fn dig(g: &mut Grid, cx: i32, cy: i32, r: i32, clear_all: bool) {
    let (w, h) = (g.w as i32, g.h as i32);
    for y in (cy - r).max(0)..=(cy + r).min(h - 1) {
        for x in (cx - r).max(0)..=(cx + r).min(w - 1) {
            if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r {
                let i = (y * w + x) as usize;
                if g.mat[i] == ROCK || g.mat[i] == DIRT || (clear_all && g.mat[i] != BEDROCK) {
                    g.mat[i] = EMPTY;
                }
            }
        }
    }
}

/// True if a disc of radius `r` at (x, y) would reach the protected border.
fn near_border(g: &Grid, x: i32, y: i32, r: i32) -> bool {
    let m = r + 10;
    x < WALL_COLS as i32 + m
        || x >= g.w as i32 - WALL_COLS as i32 - m
        || y >= g.h as i32 - FLOOR_ROWS as i32 - m
}

fn pick_entrances(seed: u64, w: i32) -> Vec<i32> {
    let want = 3 + (rng(seed, 0, 0, 0, SALT_GEN_ENTRANCE) % 3) as i32;
    let lo = WALL_COLS as i32 + 64;
    let span = w - 2 * lo;
    let band = span / want;
    // One entrance per equal band, at an rng offset inside the band's middle 60%, so neighbours
    // are at least 40% of a band apart and the whole width is covered.
    (0..want)
        .map(|k| lo + k * band + band / 5 + (rng(seed, 0, k as u32, 2, SALT_GEN_ENTRANCE_BAND) % (band as u32 * 3 / 5)) as i32)
        .collect()
}

/// Run one worm to completion, pushing branches onto `todo` and sampled positions onto `path`.
fn run_worm(g: &mut Grid, seed: u64, mut wm: Worm, todo: &mut Vec<Worm>, path: &mut Vec<(i32, i32)>, next_id: &mut u32, sc: &Scale) {
    while wm.step < wm.max_steps {
        let st = wm.step;
        let rn = |salt: u32| rng(seed, 0, wm.id, st, salt);
        if near_border(g, wm.x, wm.y, wm.r) {
            return;
        }
        dig(g, wm.x, wm.y, wm.r, false);
        if st % 8 == 0 {
            path.push((wm.x, wm.y));
        }
        if st % 12 == 0 {
            wm.r = (wm.r + (rn(SALT_GEN_WORM_R) % 3) as i32 - 1).clamp(wm.r_min, wm.r_max);
        }
        if let Some((dir, base)) = wm.horiz {
            if st % 14 == 0 {
                wm.drift = (rn(SALT_GEN_HWORM) % 3) as i32 - 1;
            }
            // Meander: change heading often, move vertically as fast as sideways, and only turn
            // back toward the base row once 70 or more cells off it.
            if (wm.y - base).abs() > 70 {
                wm.drift = (base - wm.y).signum();
            }
            if st % 2 == 0 {
                wm.y += wm.drift;
            }
            wm.x += dir * (rn(SALT_GEN_WORM_DX) % 2) as i32 + if st % 5 == 0 { 1 } else { 0 };
        } else {
            if st % 24 == 0 {
                wm.drift = (rn(SALT_GEN_WORM_DRIFT) % 3) as i32 - 1;
            }
            let dy = match rn(SALT_GEN_WORM_DY) % 10 {
                0..=6 => 1,
                7 | 8 => 0,
                _ => -1,
            };
            wm.y += dy;
            let lean = if st < 200 { wm.lean } else { 0 };
            wm.x += (wm.drift + (rn(SALT_GEN_WORM_DX) % 3) as i32 - 1).clamp(-2, 2) + lean;
            if wm.y >= wm.target_y {
                return;
            }
            if st % 220 == 219 && wm.branches > 0 {
                wm.branches -= 1;
                let id = *next_id;
                *next_id += 1;
                let deeper = scale_u(g.h as i32, 900) + (rng(seed, 0, id, 0, SALT_GEN_WORM_BRANCH) % sc.worm_branch_span as u32) as i32;
                let side = if rng(seed, 0, id, 1, SALT_GEN_WORM_BRANCH) & 1 == 0 { -1 } else { 1 };
                todo.push(Worm {
                    id,
                    x: wm.x,
                    y: wm.y,
                    r: (wm.r - 1).max(wm.r_min),
                    drift: side,
                    step: 0,
                    max_steps: 2500,
                    target_y: deeper.max(wm.y + 150),
                    branches: 0,
                    lean: side * 2,
                    ..wm
                });
            }
        }
        wm.step += 1;
    }
}

/// Entrance shafts from the surface to the deep band (with branches), plus horizontal links.
fn carve_worms(g: &mut Grid, seed: u64, surf: &[i32], path: &mut Vec<(i32, i32)>, sc: &Scale) {
    let w = g.w as i32;
    let mut todo: Vec<Worm> = Vec::new();
    let mut next_id = 1000u32;
    for (k, &x) in pick_entrances(seed, w).iter().enumerate() {
        todo.push(Worm {
            id: k as u32,
            x,
            y: surf[x as usize] - 4,
            r: sc.worm_r.2,
            r_min: sc.worm_r.0,
            r_max: sc.worm_r.1,
            drift: 0,
            step: 0,
            max_steps: 2500,
            target_y: sc.worm_target_y,
            branches: 2,
            lean: 0,
            horiz: None,
        });
    }
    for i in 0..7u32 {
        let id = 500 + i;
        let base = sc.link_rows[i as usize] + (rng(seed, 0, id, 0, SALT_GEN_HWORM) % 60) as i32;
        let x = 150 + (rng(seed, 0, id, 1, SALT_GEN_HWORM) % sc.link_x_span as u32) as i32;
        todo.push(Worm {
            id,
            x,
            y: base,
            r: sc.worm_r.2,
            r_min: sc.worm_r.0,
            r_max: sc.worm_r.1,
            drift: 0,
            step: 0,
            max_steps: 280 + (rng(seed, 0, id, 2, SALT_GEN_HWORM) % 280),
            target_y: 0,
            branches: 0,
            lean: 0,
            horiz: Some((if i & 1 == 0 { 1 } else { -1 }, base)),
        });
    }
    while let Some(wm) = todo.pop() {
        run_worm(g, seed, wm, &mut todo, path, &mut next_id, sc);
    }
}

/// Mark every Empty cell 4-connected to `start` in `seen` (1 = reached). If `region` is given the
/// reached cell indices are appended to it. Iterative, with an explicit stack.
fn flood(g: &Grid, seen: &mut [u8], start: usize, stack: &mut Vec<u32>, mut region: Option<&mut Vec<u32>>) {
    let (w, h) = (g.w, g.h);
    stack.clear();
    seen[start] = 1;
    stack.push(start as u32);
    while let Some(c) = stack.pop() {
        let i = c as usize;
        if let Some(r) = region.as_deref_mut() {
            r.push(c);
        }
        let (x, y) = (i % w, i / w);
        let mut visit = |j: usize| {
            if g.mat[j] == EMPTY && seen[j] == 0 {
                seen[j] = 1;
                stack.push(j as u32);
            }
        };
        if x > 0 {
            visit(i - 1);
        }
        if x + 1 < w {
            visit(i + 1);
        }
        if y > 0 {
            visit(i - w);
        }
        if y + 1 < h {
            visit(i + w);
        }
    }
}

/// A meandering tunnel from `from` to `to`: mostly steps along the longer axis, sometimes sideways,
/// then a straight finish if it ran out of steps. Randomness is `rng(seed, 0, id, step, SALT_GEN_LINK)`.
fn wander_link(g: &mut Grid, seed: u64, from: (i32, i32), to: (i32, i32), id: u32, rad: i32, clear_all: bool) {
    let (mut x, mut y) = from;
    let dist = (to.0 - x).abs() + (to.1 - y).abs();
    let steps = 4 * dist as u32 + 100;
    for st in 0..steps {
        dig(g, x, y, rad + ((st / 17) % 2) as i32, clear_all);
        let (dx, dy) = ((to.0 - x).signum(), (to.1 - y).signum());
        if (to.0 - x).abs() <= 2 && (to.1 - y).abs() <= 2 {
            break;
        }
        let r = rng(seed, 0, id, st, SALT_GEN_LINK);
        let long_x = (to.0 - x).abs() >= (to.1 - y).abs();
        match r % 8 {
            0 | 1 => {
                // Sideways jitter.
                let j = if r & 8 == 0 { -1 } else { 1 };
                if long_x { y += j } else { x += j }
            }
            2 => {
                x += dx;
                y += dy;
            }
            _ => {
                if long_x { x += dx } else { y += dy }
            }
        }
        x = x.clamp(WALL_COLS as i32 + 8, g.w as i32 - WALL_COLS as i32 - 8);
        y = y.clamp(8, g.h as i32 - FLOOR_ROWS as i32 - 12);
    }
    let (dx, dy) = (to.0 - x, to.1 - y);
    let n = dx.abs().max(dy.abs()).max(1);
    for k in 0..=n {
        dig(g, x + dx * k / n, y + dy * k / n, rad, clear_all);
    }
}

/// Box the repair guarantees: the 5x10 hitbox plus a one-cell margin.
const FIT_W: usize = crate::tuning::HITBOX_W as usize + 1;
const FIT_H: usize = crate::tuning::HITBOX_H as usize + 1;
const REPAIR_PASSES: u32 = 3;
/// Entrance shaft and link worm radii at L (cells): about 2-3 player bodies tall (the hitbox is 10 tall).
const WORM_R_MIN: i32 = 10;
const WORM_R_MAX: i32 = 16;
const WORM_R_START: i32 = 12;

/// Flood a `bw` x `bh` box (keyed by top-left) through Empty cells from `start`. Returns the top-left
/// of the box whose bottom is deepest, or None if the start box does not fit. Liquids, sand and solids block.
pub fn box_reach(g: &Grid, start: (usize, usize), bw: usize, bh: usize) -> Option<(usize, usize)> {
    let (w, h) = (g.w, g.h);
    let mut ps = vec![0u32; (w + 1) * (h + 1)];
    for y in 0..h {
        for x in 0..w {
            let solid = u32::from(g.mat[y * w + x] != EMPTY);
            ps[(y + 1) * (w + 1) + x + 1] = solid + ps[y * (w + 1) + x + 1] + ps[(y + 1) * (w + 1) + x] - ps[y * (w + 1) + x];
        }
    }
    let fits = |x: usize, y: usize| {
        x + bw <= w && y + bh <= h && {
            let (x1, y1) = (x + bw, y + bh);
            ps[y1 * (w + 1) + x1] + ps[y * (w + 1) + x] == ps[y * (w + 1) + x1] + ps[y1 * (w + 1) + x]
        }
    };
    if !fits(start.0, start.1) {
        return None;
    }
    let mut seen = vec![false; w * h];
    let mut stack = vec![start];
    seen[start.1 * w + start.0] = true;
    let mut deepest = start;
    while let Some((x, y)) = stack.pop() {
        if y > deepest.1 {
            deepest = (x, y);
        }
        let mut nb = [(usize::MAX, 0); 4];
        if x > 0 {
            nb[0] = (x - 1, y)
        }
        nb[1] = (x + 1, y);
        if y > 0 {
            nb[2] = (x, y - 1)
        }
        nb[3] = (x, y + 1);
        for (nx, ny) in nb {
            if nx != usize::MAX && nx < w && ny < h && !seen[ny * w + nx] && fits(nx, ny) {
                seen[ny * w + nx] = true;
                stack.push((nx, ny));
            }
        }
    }
    Some(deepest)
}

/// Box-fit repair: if a body cannot walk from the surface centre to `sc.repair_depth` (tuned per size so
/// its box bottom clears `sc.traversal_target`, the same way L's 1420/1380 pair did), carve a 6-radius
/// tunnel from the deepest cell it reaches down to that depth. At most REPAIR_PASSES passes.
/// Runs after the materials so pools and piles cannot plug the path; the tunnel clears them.
fn repair_traversal(g: &mut Grid, seed: u64, sc: &Scale) {
    let start = (g.w / 2, 0usize);
    for pass in 0..REPAIR_PASSES {
        let Some((dx, dy)) = box_reach(g, start, FIT_W, FIT_H) else { return };
        if (dy + FIT_H) as i32 >= sc.repair_depth {
            return;
        }
        let from = ((dx + FIT_W / 2) as i32, (dy + FIT_H / 2) as i32);
        wander_link(g, seed, from, (from.0, sc.repair_depth), 2000 + pass, 6, true);
        // A tunnel through a pool's floor leaves liquid hanging; drain it, bottom-up so a column cascades.
        let w = g.w;
        for i in (0..g.mat.len() - w).rev() {
            if (g.mat[i] == WATER || g.mat[i] == LAVA) && g.mat[i + w] == EMPTY {
                g.mat[i] = EMPTY;
            }
        }
    }
}

/// Smallest open region worth keeping (cells).
pub const MIN_REGION: usize = 400;

/// Reach everything from the sky: small unreachable pockets become Rock, big ones get a straight
/// tunnel to the nearest worm path point, then anything still cut off is filled.
fn connect_and_prune(g: &mut Grid, seed: u64, path: &[(i32, i32)]) {
    let w = g.w;
    let mut seen = vec![0u8; g.mat.len()];
    let mut stack: Vec<u32> = Vec::new();
    let mut region: Vec<u32> = Vec::new();
    // The sky: row 0 is Empty everywhere inside the walls.
    flood(g, &mut seen, w / 2, &mut stack, None);
    for i in 0..g.mat.len() {
        if g.mat[i] != EMPTY || seen[i] != 0 {
            continue;
        }
        region.clear();
        flood(g, &mut seen, i, &mut stack, Some(&mut region));
        if region.len() < MIN_REGION {
            for &c in &region {
                g.mat[c as usize] = ROCK;
            }
            continue;
        }
        // Nearest path point to the region's first cell, then the region cell nearest that point.
        let (fx, fy) = ((i % w) as i32, (i / w) as i32);
        let d2 = |a: (i32, i32), x: i32, y: i32| (a.0 - x) * (a.0 - x) + (a.1 - y) * (a.1 - y);
        let Some(&t) = path.iter().min_by_key(|&&p| (d2(p, fx, fy), p)) else { continue };
        let rep = region
            .iter()
            .map(|&c| ((c as usize % w) as i32, (c as usize / w) as i32))
            .min_by_key(|&(x, y)| (d2(t, x, y), x, y))
            .unwrap_or((fx, fy));
        wander_link(g, seed, rep, t, i as u32, 5, false);
    }
    // Links can open other pockets or leave a sliver cut off: reflood and fill what is left.
    seen.fill(0);
    flood(g, &mut seen, w / 2, &mut stack, None);
    for i in 0..g.mat.len() {
        if g.mat[i] == EMPTY && seen[i] == 0 && i / w >= 100 {
            g.mat[i] = ROCK;
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
        // Entrance shafts (up to 5, each about 2 x WORM_R_MAX wide since F1) open columns, so allow a small fraction outside the band.
        let bad = (WALL_COLS + 1..g.w - WALL_COLS).filter(|&x| !(190..=270).contains(&top(x))).count();
        assert!(bad < 120, "{bad} columns off the surface band");
        let shallow: Vec<u8> = (300..780).flat_map(|y| g.mat[y * g.w + 20..y * g.w + 2028].to_vec()).collect();
        let open = shallow.iter().filter(|&&m| m == EMPTY).count() * 100 / shallow.len();
        assert!((10..=40).contains(&open), "shallow band is {open}% open");
    }

    #[test]
    fn every_open_cell_is_reachable_from_the_sky() {
        for seed in [1u64, 2, 3] {
            let s = Sim::new(seed, 1).unwrap();
            let g = &s.grid;
            // Pools and piles may plug a passage, so reach through any non-solid material.
            let open = |m: u8| matches!(m, EMPTY | WATER | LAVA | SAND | GUNPOWDER);
            let mut seen = vec![0u8; g.mat.len()];
            let mut stack = vec![(g.w / 2) as u32];
            seen[g.w / 2] = 1;
            while let Some(c) = stack.pop() {
                let i = c as usize;
                let (x, y) = (i % g.w, i / g.w);
                let mut nb = Vec::new();
                if x > 0 { nb.push(i - 1) }
                if x + 1 < g.w { nb.push(i + 1) }
                if y > 0 { nb.push(i - g.w) }
                if y + 1 < g.h { nb.push(i + g.w) }
                for j in nb {
                    if open(g.mat[j]) && seen[j] == 0 {
                        seen[j] = 1;
                        stack.push(j as u32);
                    }
                }
            }
            // Sky pockets walled in by tree branches are cosmetic, so only look below the surface band.
            let stranded = (SHALLOW_TOP as usize * g.w..g.mat.len()).filter(|&i| open(g.mat[i]) && seen[i] == 0).count();
            let first: Vec<(usize, usize, u8)> = (0..g.mat.len()).filter(|&i| i / g.w >= SHALLOW_TOP as usize && open(g.mat[i]) && seen[i] == 0).take(5).map(|i| (i % g.w, i / g.w, g.mat[i])).collect();
            assert_eq!(stranded, 0, "seed {seed}: {first:?}");
            let deep_open = (DEEP_TOP as usize..g.h).map(|y| (0..g.w).filter(|&x| seen[y * g.w + x] == 1).count()).sum::<usize>();
            assert!(deep_open > 20_000, "seed {seed}: only {deep_open} reachable deep cells");
        }
    }

    #[test]
    fn liquids_rest_on_something_and_lava_keeps_away_from_gunpowder() {
        for seed in [1u64, 5] {
            let s = Sim::new(seed, 1).unwrap();
            let g = &s.grid;
            let (mut water, mut lava, mut gp, mut sand, mut wood) = (0, 0, 0, 0, 0);
            for y in 0..g.h - 1 {
                for x in 0..g.w {
                    let m = g.mat[y * g.w + x];
                    match m {
                        WATER | LAVA => {
                            assert_ne!(g.mat[(y + 1) * g.w + x], EMPTY, "floating liquid at {x},{y}");
                            if m == WATER { water += 1 } else { lava += 1 }
                            if m == WATER {
                                assert!((SHALLOW_TOP as usize..DEEP_TOP as usize).contains(&y));
                            } else {
                                assert!(y >= DEEP_TOP as usize);
                            }
                        }
                        GUNPOWDER => {
                            gp += 1;
                            assert!(y >= DEEP_TOP as usize);
                            assert!(!near_material(g, x as i32, y as i32, 8, 8, LAVA), "gunpowder near lava at {x},{y}");
                        }
                        SAND => sand += 1,
                        WOOD => wood += 1,
                        _ => {}
                    }
                }
            }
            assert!(water > 80 && lava > 400 && gp > 600 && sand > 500 && wood > 200, "{water} {lava} {gp} {sand} {wood}");
        }
    }

    #[test]
    fn pickup_spots_are_on_floors_in_their_band() {
        let s = Sim::new(2, 1).unwrap();
        let g = &s.grid;
        let band = |p: &crate::entities::Pickup| u8::from(p.spell >= 4);
        let shallow = s.pickups.iter().filter(|p| band(p) == 0).count();
        let deep = s.pickups.iter().filter(|p| band(p) == 1).count();
        assert!(shallow >= 30 && deep >= 18, "{shallow} shallow, {deep} deep");
        for p in &s.pickups {
            let (x, y) = (p.x as usize, p.y as usize);
            assert_eq!(g.mat[y * g.w + x], EMPTY);
            assert!(solid_ground(g.mat[(y + 1) * g.w + x]));
            assert_eq!(band(p) == 1, y >= DEEP_TOP as usize);
        }
        assert_eq!(s.pickups, Sim::new(2, 1).unwrap().pickups);
    }

    #[test]
    fn entrances_are_spread_and_few() {
        for seed in 0..20u64 {
            let xs = pick_entrances(seed, 2048);
            assert!((3..=5).contains(&xs.len()), "seed {seed}: {xs:?}");
            assert!(xs.windows(2).all(|p| p[1] - p[0] >= 150));
            assert!(xs[0] < 2048 / 3 && *xs.last().unwrap() > 2048 * 2 / 3, "seed {seed}: {xs:?}");
        }
    }

    /// Deepest row a box of `bw` x `bh` cells can reach by moving one cell at a time through Empty cells,
    /// starting from the spawn point. Liquids, sand and every solid count as blocking: stricter than play.
    fn deepest_box_reach(g: &Grid, spawn: (i32, i32), bw: usize, bh: usize) -> Option<usize> {
        let (w, h) = (g.w, g.h);
        // Prefix sums of solid cells, so "is this box all Empty" is O(1).
        let mut ps = vec![0u32; (w + 1) * (h + 1)];
        for y in 0..h {
            for x in 0..w {
                let solid = u32::from(g.mat[y * w + x] != EMPTY);
                ps[(y + 1) * (w + 1) + x + 1] = solid + ps[y * (w + 1) + x + 1] + ps[(y + 1) * (w + 1) + x] - ps[y * (w + 1) + x];
            }
        }
        // A box is keyed by its top-left cell.
        let fits = |x: usize, y: usize| {
            x + bw <= w && y + bh <= h && {
                let (x1, y1) = (x + bw, y + bh);
                ps[y1 * (w + 1) + x1] + ps[y * (w + 1) + x] == ps[y * (w + 1) + x1] + ps[y1 * (w + 1) + x]
            }
        };
        let foot_x = (spawn.0 / crate::tuning::POS_ONE) as usize;
        let foot_y = (spawn.1 / crate::tuning::POS_ONE) as usize;
        // The spawn's feet rest on the ground row; try box positions around it.
        let start = (0..=bw)
            .flat_map(|dx| (0..=3).map(move |dy| (dx, dy)))
            .map(|(dx, dy)| (foot_x.saturating_sub(dx), foot_y.saturating_sub(bh + dy)))
            .find(|&(x, y)| fits(x, y))?;
        let mut seen = vec![false; w * h];
        let mut stack = vec![start];
        seen[start.1 * w + start.0] = true;
        let mut deepest = start.1 + bh;
        while let Some((x, y)) = stack.pop() {
            deepest = deepest.max(y + bh);
            let mut nb = [(usize::MAX, 0); 4];
            if x > 0 { nb[0] = (x - 1, y) }
            nb[1] = (x + 1, y);
            if y > 0 { nb[2] = (x, y - 1) }
            nb[3] = (x, y + 1);
            for (nx, ny) in nb {
                if nx != usize::MAX && nx < w && ny < h && !seen[ny * w + nx] && fits(nx, ny) {
                    seen[ny * w + nx] = true;
                    stack.push((nx, ny));
                }
            }
        }
        Some(deepest)
    }

    /// Gen v2's target (plan-game-modes R1, research `cave-gen-v2.md`): a body a margin bigger than the 5x10
    /// hitbox can walk from spawn to the bottom of the deep band, at every Caves size (R1: S and M join L).
    /// Each size's target is proportional to its own usable height (`traversal_target_for`, scaled from
    /// L's 1380/1472). Shown red against the un-scaled generator before this change (see the worker report).
    #[test]
    fn traversable_to_every_band() {
        use crate::config::RoomConfig;
        let (bw, bh) = (crate::tuning::HITBOX_W as usize + 1, crate::tuning::HITBOX_H as usize + 1);
        let mut failures = Vec::new();
        for size in 0u8..=2 {
            let cfg = RoomConfig { size, ..RoomConfig::caves_pvp() };
            let (_, h) = cfg.dims();
            let target = traversal_target_for(h as i32);
            for seed in 1..=8u64 {
                let s = Sim::new(seed, cfg).unwrap();
                let spawn = s.spawn_point(1);
                match deepest_box_reach(&s.grid, spawn, bw, bh) {
                    None => failures.push(format!("size {size} seed {seed}: no {bw}x{bh} box fits at spawn {spawn:?}")),
                    Some(d) if (d as i32) < target => failures.push(format!("size {size} seed {seed}: reaches y={d}, needs {target}")),
                    Some(_) => {}
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// Measurement: native release gen time and pickups per band and size. `--ignored`; writes /tmp/f1-gen.txt.
    #[test]
    #[ignore = "measurement"]
    fn measure_gen_time_and_pickups() {
        use crate::config::RoomConfig;
        let mut out = String::new();
        for size in 0u8..=2 {
            let cfg = RoomConfig { size, ..RoomConfig::caves_pvp() };
            let (mut best, mut open, mut sh, mut dp) = (u128::MAX, 0usize, 0usize, 0usize);
            for seed in 1..=4u64 {
                let t = std::time::Instant::now();
                let s = Sim::new(seed, cfg).unwrap();
                best = best.min(t.elapsed().as_micros());
                open += s.grid.mat.iter().filter(|&&m| m == EMPTY).count() * 100 / s.grid.mat.len();
                sh += s.pickups.iter().filter(|p| p.spell < 4).count();
                dp += s.pickups.iter().filter(|p| p.spell >= 4).count();
            }
            out += &format!("size {size}: best {} ms, open {}% avg, pickups/seed shallow {} deep {}\n", best / 1000, open / 4, sh / 4, dp / 4);
        }
        std::fs::write("/tmp/f1-gen.txt", out).unwrap();
    }
}
