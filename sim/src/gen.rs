//! World generation for `world_kind` 1 (plan 6.9, research/noita-caves.md section 4).
//!
//! Integer-only (clippy denies floats), no recursion, no `HashMap`. Every random draw is
//! `rng(seed, 0, x, y, SALT_GEN_*)` with a salt per use. The generator writes straight into the grid
//! without touching chunk metadata, so every chunk starts pristine.
#![allow(clippy::manual_is_multiple_of, clippy::needless_range_loop, clippy::too_many_arguments)]

use crate::grid::Grid;
use crate::materials::*;
use crate::rng::*;
use crate::tuning::{ARENA_KEEP_OUT, ARENA_RX_L, ARENA_RX_MIN, ARENA_RY_L, ARENA_RY_MIN, SUPPLY_ALCOVE_H, SUPPLY_ALCOVE_W, SUPPLY_PILE, ENEMY_WORM, ENEMY_WORMS_L, ENEMY_WORMS_MIN, WORM_BURIED_CELLS, ENEMY_ACID_SLIME, ENEMY_ACID_SLIMES_L, ENEMY_ACID_SLIMES_MIN, ENEMY_IMP, ENEMY_IMPS_L, ENEMY_IMPS_MIN, ENEMY_SLIME, ENEMY_SLIMES_L, ENEMY_SLIMES_MIN, ENEMY_SPAWN_CLEAR, ENEMY_SPAWN_ROWS};

pub const FLOOR_ROWS: usize = 64;
pub const WALL_COLS: usize = 16;
/// Mean surface height; the heightfield stays within about 200..260.
pub const SURFACE_Y: i32 = 230;
pub const SHALLOW_TOP: i32 = 260;
pub const DEEP_TOP: i32 = 800;
/// Acid pools keep this many cells (Chebyshev) from every path point.
const ACID_PATH_MARGIN: i32 = 40;
/// Gas pockets: rows filled under a roof, and the open height required below it.
const GAS_POCKET_ROWS: i32 = 6;
const GAS_MIN_HEIGHT: i32 = 24;
/// Radius of an ice-lined chamber, cells.
/// Biome kinds (a site's `kind`). 3 (grotto) and 4 (mine) are reserved for later slices.
pub const BIOME_LAVA: u8 = 1;
pub const BIOME_ICE: u8 = 2;
/// Lava lake and ice cave radii at L (rx, cells); `ry` is 2/5 and 1/2 of it.
const LAVA_RX_MIN: i32 = 70;
const LAVA_RX_MAX: i32 = 110;
const ICE_RX_MIN: i32 = 45;
const ICE_RX_MAX: i32 = 65;
/// Cells a site keeps clear of every other site.
const SITE_GAP: i32 = 40;
/// A lava-site dam may strand at most this many open cells (they are filled); more and the dam is undone.
const DAM_STRAND_MAX: usize = 1500;

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
    oil_count: i32,
    acid_count: i32,
    gas_count: i32,
    /// Biome sites per kind (lava, ice), their radius ranges (rx, cells) and the chambers' width percentage.
    biome_count: (i32, i32),
    lava_rx: (i32, i32),
    ice_rx: (i32, i32),
    pct: i32,
    coal_count: i32,
    worm_target_y: i32,
    worm_branch_span: i32,
    link_x_span: i32,
    target_spots: [(i32, i32, i32); 2],
    /// Worm radii (min, max, start), cells: roomy tunnels, two to three bodies tall at L, scaled down on small worlds.
    worm_r: (i32, i32, i32),
    /// Open caverns (shallow band, deep band) and their radius range, cells; same size scaling as the worms.
    chambers: (i32, i32),
    chamber_r: (i32, i32),
    /// Boss arena radii (rx, ry), cells.
    arena_r: (i32, i32),
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
            oil_count: scale_count(w, h, 24, 6),
            acid_count: scale_count(w, h, 10, 3),
            gas_count: scale_count(w, h, 14, 3),
            biome_count: (scale_count(w, h, 3, 1), scale_count(w, h, 3, 1)),
            lava_rx: (wr(LAVA_RX_MIN), wr(LAVA_RX_MAX)),
            ice_rx: (wr(ICE_RX_MIN), wr(ICE_RX_MAX)),
            pct,
            coal_count: scale_count(w, h, 36, 6),
            worm_target_y,
            worm_branch_span: scale_u(h, 450).max(60),
            link_x_span: (w - 348).max(40),
            chambers: (scale_count(w, h, 4, 1), scale_count(w, h, 8, 2)),
            chamber_r: (wr(CHAMBER_R_MIN), wr(CHAMBER_R_MAX)),
            arena_r: ((ARENA_RX_L * pct / 100).max(ARENA_RX_MIN), (ARENA_RY_L * pct / 100).max(ARENA_RY_MIN)),
            worm_r: (wr(WORM_R_MIN), wr(WORM_R_MAX), wr(WORM_R_START)),
            target_spots: [
                (shallow_top + 40, deep_top - 40, scale_count(w, h, 40, 8)),
                (deep_top + 40, scale_u(h, 1400), scale_count(w, h, 25, 6)),
            ],
        }
    }
}

/// The boss arena (F6): one flat-floored ellipse in the deep band, only in worlds with enemies (Survival).
/// Derived from (seed, path), so it is not state; `Sim` keeps it beside the grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Arena {
    pub cx: i32,
    pub cy: i32,
    pub rx: i32,
    pub ry: i32,
    /// First solid row of the flat floor (the open air ends at `floor_y - 1`).
    pub floor_y: i32,
    /// +1 or -1: the side of the supply alcove.
    pub side: i32,
}

impl Arena {
    /// True when (x, y) lies inside the ellipse grown by `margin` cells on every side. Integer only.
    pub fn contains(&self, x: i32, y: i32, margin: i32) -> bool {
        let (rx, ry) = (i64::from(self.rx + margin), i64::from(self.ry + margin));
        let (dx, dy) = (i64::from(x - self.cx), i64::from(y - self.cy));
        dx * dx * ry * ry + dy * dy * rx * rx <= rx * rx * ry * ry
    }
    /// Half the width of the open air at the floor row: `rx * 0.866`, as the integer `rx * 433 / 500`.
    pub fn floor_half_width(&self) -> i32 {
        self.rx * 433 / 500
    }
}

/// A biome site: an ellipse centred on a worm-path point (plan section 1). A pure function of (seed, size).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Site {
    pub kind: u8,
    pub cx: i32,
    pub cy: i32,
    pub rx: i32,
    pub ry: i32,
}

impl Site {
    /// True when (x, y) lies inside the ellipse. Integer only.
    pub fn inside(&self, x: i32, y: i32) -> bool {
        let (dx, dy) = (i64::from(x - self.cx), i64::from(y - self.cy));
        dx * dx * i64::from(self.ry * self.ry) + dy * dy * i64::from(self.rx * self.rx) <= i64::from(self.rx * self.rx) * i64::from(self.ry * self.ry)
    }
}

/// Everything `generate_world` makes besides the grid.
pub struct World {
    pub sites: Vec<Site>,
    pub spots: Vec<PickupSpot>,
    pub path: Vec<(i32, i32)>,
    pub arena: Option<Arena>,
}

/// Generate a game world into an all-Empty grid.
pub fn generate(g: &mut Grid, seed: u64) -> Vec<PickupSpot> {
    generate_with_path(g, seed).0
}

/// `generate`, also returning the guaranteed worm path (tests measure placements against it).
pub(crate) fn generate_with_path(g: &mut Grid, seed: u64) -> (Vec<PickupSpot>, Vec<(i32, i32)>) {
    let w = generate_world(g, seed, false);
    (w.spots, w.path)
}

/// The generator. `with_arena` (Survival only) adds the boss arena and its supply pile; without it the terrain is
/// byte for byte what it was before F6.
pub fn generate_world(g: &mut Grid, seed: u64, with_arena: bool) -> World {
    let (w, h) = (g.w as i32, g.h as i32);
    let sc = Scale::new(w, h);
    let surf = surface_heights(seed, w, h, sc.surface_y);
    fill_terrain(g, seed, &surf);
    carve_noise_caves(g, seed, &surf, &sc);
    let mut path = Vec::new();
    carve_worms(g, seed, &surf, &mut path, &sc);
    carve_chambers(g, seed, &path, &sc);
    let arena = if with_arena { carve_arena(g, seed, &path, &sc) } else { None };
    let sites = pick_sites(g, seed, &path, &sc, arena.as_ref());
    carve_sites(g, &sites);
    connect_and_prune(g, seed, &path);
    line_entrances_with_dirt(g, seed, &surf);
    let mut pool_scratch = PoolScratch { mark: vec![0u8; g.mat.len()], stack: Vec::new(), region: Vec::new() };
    // Ice sites are dammed before any liquid is placed (a pocket the dam strands is filled, not left holding a pool).
    for s in sites.iter().filter(|s| s.kind == BIOME_ICE) {
        seal_site(g, s);
    }
    fill_lava_lakes(g, seed, &mut pool_scratch, &sites, &sc);
    place_sand(g, seed, &sc);
    place_lava(g, seed, &mut pool_scratch, &sc);
    place_gunpowder(g, seed, &sc);
    place_water(g, seed, &mut pool_scratch, &sc);
    place_trees(g, seed, &surf, &sc);
    place_oil(g, seed, &mut pool_scratch, &sc);
    place_acid(g, seed, &mut pool_scratch, &sc, &path);
    place_gas_pockets(g, seed, &sc, &path);
    place_ice(g, seed, &mut pool_scratch, &sites);
    place_coal(g, seed, &sc);
    if let Some(a) = &arena {
        clear_arena(g, a);
    }
    repair_traversal(g, seed, &sc);
    if let Some(a) = &arena {
        reseal_floor(g, a, &sc);
    }
    let mut spots = pick_spots(g, seed, &sc, arena.as_ref());
    if let Some(a) = &arena {
        supply_pile(a, &mut spots);
    }
    World { sites, spots, path, arena }
}

/// The arena: centred on a worm-path point in the deep band between `deep_top` and `repair_depth - 40`, clear of the
/// border (the supply alcove included), so it joins the traversal network. Rock and Dirt above the floor row become
/// Empty; Empty cells inside the ellipse at or below the floor row become Rock (a flat floor); two or three pillars
/// stand on the floor for cover; a niche for the supply pile opens beside the floor. A fixed-size ellipse: bounded.
fn carve_arena(g: &mut Grid, seed: u64, path: &[(i32, i32)], sc: &Scale) -> Option<Arena> {
    let (w, h) = (g.w as i32, g.h as i32);
    let (rx, ry) = sc.arena_r;
    let reach = rx + SUPPLY_ALCOVE_W + 8;
    let clear = |p: &&(i32, i32)| {
        p.1 - ry >= sc.surface_y + 60 && p.1 + ry < h - FLOOR_ROWS as i32 - 12 && !near_border(g, p.0, p.1, reach)
    };
    let in_band = |p: &&(i32, i32)| p.1 >= sc.deep_top && p.1 <= sc.repair_depth - 40;
    // Only a path point already open to the sky: a point in a sealed pocket would be filled by `connect_and_prune`.
    let mut seen = vec![0u8; g.mat.len()];
    let mut stack = Vec::new();
    flood(g, &mut seen, g.w / 2, &mut stack, None);
    let open = |p: &&(i32, i32)| seen[(p.1 * w + p.0) as usize] != 0;
    let mut cands: Vec<(i32, i32)> = path.iter().filter(clear).filter(in_band).filter(open).copied().collect();
    if cands.is_empty() {
        // No path point in the band (a tiny world): the clear point nearest the middle of the band.
        let mid = (sc.deep_top + sc.repair_depth - 40) / 2;
        cands = path.iter().filter(clear).filter(open).min_by_key(|p| ((p.1 - mid).abs(), p.0)).copied().into_iter().collect();
    }
    if cands.is_empty() {
        return None;
    }
    let (cx, cy) = cands[(rng(seed, 0, 0, 0, SALT_GEN_ARENA) % cands.len() as u32) as usize];
    let floor_y = cy + ry / 2;
    let mut a = Arena { cx, cy, rx, ry, floor_y, side: 1 };
    // The alcove goes on the side of the nearest path point outside the ellipse, else an rng side.
    a.side = path
        .iter()
        .filter(|p| !a.contains(p.0, p.1, 0))
        .min_by_key(|p| ((p.0 - cx) * (p.0 - cx) + (p.1 - cy) * (p.1 - cy), **p))
        .map_or(if rng(seed, 0, 0, 0, SALT_GEN_ARENA_SIDE) & 1 == 0 { 1 } else { -1 }, |p| if p.0 < cx { -1 } else { 1 });
    for y in (cy - ry).max(0)..=(cy + ry).min(h - 1) {
        for x in (cx - rx).max(0)..=(cx + rx).min(w - 1) {
            if !a.contains(x, y, 0) {
                continue;
            }
            let i = (y * w + x) as usize;
            if y < floor_y {
                if g.mat[i] == ROCK || g.mat[i] == DIRT {
                    g.mat[i] = EMPTY;
                }
            } else if g.mat[i] == EMPTY {
                g.mat[i] = ROCK;
            }
        }
    }
    // Pillars: low rock columns on the floor, away from the middle so the boss's spawn stays clear.
    let (pw, ph) = (4, (ry / 3).max(6));
    let third = (rng(seed, 0, 0, 0, SALT_GEN_ARENA_PILLAR) & 1) as i32 * 2 - 1;
    for off in [-rx * 3 / 5, rx * 3 / 5, third * rx * 3 / 10] {
        for y in floor_y - ph..floor_y {
            for x in cx + off - pw / 2..cx + off + pw / 2 {
                let i = (y * w + x) as usize;
                if a.contains(x, y, 0) && g.mat[i] == EMPTY {
                    g.mat[i] = ROCK;
                }
            }
        }
    }
    // The alcove: a niche from just inside the rim outward, on the floor row, so the pile is joined to the arena.
    let hw = a.floor_half_width();
    let (x_in, x_out) = (hw - 4, hw + SUPPLY_ALCOVE_W);
    for d in x_in..=x_out {
        let x = cx + a.side * d;
        for y in floor_y - SUPPLY_ALCOVE_H..=floor_y {
            let i = (y * w + x) as usize;
            if y < floor_y {
                if g.mat[i] == ROCK || g.mat[i] == DIRT {
                    g.mat[i] = EMPTY;
                }
            } else if g.mat[i] == EMPTY {
                g.mat[i] = ROCK;
            }
        }
    }
    Some(a)
}

/// After every material is placed: liquids, gas, fire, sand and gunpowder inside the arena grown by `ARENA_KEEP_OUT`
/// become Empty (no pool on the floor, no gas or lava pocket beside it). The supply alcove is outside the ellipse but
/// not the margin, so it is cleared too; its pickups are placed afterwards.
fn clear_arena(g: &mut Grid, a: &Arena) {
    let (w, h) = (g.w as i32, g.h as i32);
    let m = ARENA_KEEP_OUT;
    for y in (a.cy - a.ry - m).max(0)..=(a.cy + a.ry + m).min(h - 1) {
        for x in (a.cx - a.rx - m).max(0)..=(a.cx + a.rx + m).min(w - 1) {
            if a.contains(x, y, m) {
                let i = (y * w + x) as usize;
                if is_liquid(g.mat[i]) || is_gas(g.mat[i]) || matches!(g.mat[i], SAND | GUNPOWDER) {
                    g.mat[i] = EMPTY;
                }
            }
        }
    }
    let hw = a.floor_half_width();
    for d in hw - 4..=hw + SUPPLY_ALCOVE_W {
        let x = a.cx + a.side * d;
        for y in a.floor_y - SUPPLY_ALCOVE_H..a.floor_y {
            let i = (y * w + x) as usize;
            if is_liquid(g.mat[i]) || is_gas(g.mat[i]) || matches!(g.mat[i], SAND | GUNPOWDER) {
                g.mat[i] = EMPTY;
            }
        }
    }
}

/// `repair_traversal` may cut a radius-6 tunnel through the arena floor. Seal the floor row (Rock, two rows deep) again, and
/// keep the seal only if a body can still walk from the surface to the repair depth; otherwise undo it, so traversal always wins.
fn reseal_floor(g: &mut Grid, a: &Arena, sc: &Scale) {
    let w = g.w as i32;
    let hw = a.floor_half_width();
    let mut undo: Vec<(usize, u8)> = Vec::new();
    for x in a.cx - hw..=a.cx + hw {
        for y in a.floor_y..a.floor_y + 2 {
            let i = (y * w + x) as usize;
            if g.mat[i] != ROCK && g.mat[i] != BEDROCK && g.mat[i] != DIRT {
                undo.push((i, g.mat[i]));
                g.mat[i] = ROCK;
            }
        }
    }
    if undo.is_empty() {
        return;
    }
    let ok = box_reach(g, (g.w / 2, 0), FIT_W, FIT_H).is_some_and(|(_, dy)| (dy + FIT_H) as i32 >= sc.repair_depth);
    if !ok {
        for (i, m) in undo {
            g.mat[i] = m;
        }
    }
}

/// The supply pile: `SUPPLY_PILE` pickups of the deep spells in the alcove, outside the ellipse, 4 cells apart.
fn supply_pile(a: &Arena, spots: &mut Vec<PickupSpot>) {
    let first = a.floor_half_width() + 6;
    for (k, &spell) in SUPPLY_PILE.iter().enumerate() {
        let x = a.cx + a.side * (first + 4 * k as i32);
        spots.push(PickupSpot { x: x as u16, y: (a.floor_y - 1) as u16, band: 1, fixed: Some(spell) });
    }
}

/// Slimes: the shallow band's floors, at most `want` of them (F4, D-157: placed once, never respawned). Returns cells
/// (x, y) of the Empty floor cell, in placement order, which is the enemy id order. Kept off the surface spawn
/// area (`ENEMY_SPAWN_CLEAR` columns either side of the world centre, within `ENEMY_SPAWN_ROWS` rows of the
/// shallow top), off pickups, out of liquids (the whole 5x4 body must be Empty), and apart from each other.
pub fn enemy_spots(g: &Grid, seed: u64, pickups: &[(u16, u16)], arena: Option<&Arena>) -> Vec<(u16, u16, u8)> {
    let (w, h) = (g.w as i32, g.h as i32);
    let sc = Scale::new(w, h);
    let mut all: Vec<(u16, u16, u8)> = Vec::new();
    let want = scale_count(w, h, ENEMY_SLIMES_L, ENEMY_SLIMES_MIN) as usize;
    let (y_lo, y_hi) = (sc.shallow_top + 20, (sc.deep_top - 40).max(sc.shallow_top + 60));
    floor_spots(g, seed, pickups, &mut all, ENEMY_SLIME, want, (y_lo, y_hi), (SALT_GEN_ENEMY_X, SALT_GEN_ENEMY_Y), arena);
    imp_spots(g, seed, &sc, pickups, &mut all, arena);
    worm_spots(g, seed, &sc, pickups, &mut all, arena);
    let want = scale_count(w, h, ENEMY_ACID_SLIMES_L, ENEMY_ACID_SLIMES_MIN) as usize;
    let (y_lo, y_hi) = (sc.deep_top + 20, (sc.repair_depth - 20).max(sc.deep_top + 60));
    floor_spots(g, seed, pickups, &mut all, ENEMY_ACID_SLIME, want, (y_lo, y_hi), (SALT_GEN_ACID_SLIME_X, SALT_GEN_ACID_SLIME_Y), arena);
    all
}

/// Walkers on floors in the row range `rows`: up to `want` of `kind`, appended to `all`. The whole 5x4 body must be
/// Empty (no liquid, gas or plant), the floor not sand, clear of pickups, the spawn area, and every enemy already placed.
#[allow(clippy::too_many_arguments)]
fn floor_spots(g: &Grid, seed: u64, pickups: &[(u16, u16)], all: &mut Vec<(u16, u16, u8)>, kind: u8, want: usize, rows: (i32, i32), salts: (u32, u32), arena: Option<&Arena>) {
    let (w, h) = (g.w as i32, g.h as i32);
    let sc = Scale::new(w, h);
    let (y_lo, y_hi) = rows;
    let mut placed = 0usize;
    for k in 0..6000u32 {
        if placed >= want {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, salts.0) % (w - 80) as u32) as i32;
        let y = y_lo + (rng(seed, 0, k, 0, salts.1) % (y_hi - y_lo) as u32) as i32;
        if (x - w / 2).abs() <= ENEMY_SPAWN_CLEAR && y < sc.shallow_top + ENEMY_SPAWN_ROWS {
            continue;
        }
        let Some(yf) = find_floor(g, x, y, 100) else { continue };
        if yf < y_lo || yf > y_hi {
            continue;
        }
        let body = (x - 2..=x + 2).all(|bx| (yf - 3..=yf).all(|by| g.mat[(by * w + bx) as usize] == EMPTY));
        if !body || g.mat[((yf + 1) * w + x) as usize] == SAND {
            continue;
        }
        if arena.is_some_and(|a| a.contains(x, yf, ARENA_KEEP_OUT)) {
            continue;
        }
        if pickups.iter().any(|&(px, py)| (i32::from(px) - x).abs() < 8 && (i32::from(py) - yf).abs() < 8) {
            continue;
        }
        if all.iter().any(|&(ox, oy, _)| (i32::from(ox) - x).abs() < 20 && (i32::from(oy) - yf).abs() < 20) {
            continue;
        }
        all.push((x as u16, yf as u16, kind));
        placed += 1;
    }
}

/// Burrower worms (F5): buried in solid Rock in the lower half of the deep band, with `WORM_BURIED_CELLS` cells of Rock
/// in every direction around the centre (so every cell near it, and any open cell, is a few cells away), off the pickups
/// and apart from every other enemy. `(x, y)` is the bottom row of the 5x4 body, so the centre is two rows above.
fn worm_spots(g: &Grid, seed: u64, sc: &Scale, pickups: &[(u16, u16)], all: &mut Vec<(u16, u16, u8)>, arena: Option<&Arena>) {
    let (w, h) = (g.w as i32, g.h as i32);
    let want = scale_count(w, h, ENEMY_WORMS_L, ENEMY_WORMS_MIN) as usize;
    let (y_lo, y_hi) = ((sc.deep_top + sc.repair_depth) / 2, sc.repair_depth);
    let r = WORM_BURIED_CELLS;
    let mut placed = 0usize;
    for k in 0..12000u32 {
        if placed >= want {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_WORM_X) % (w - 80) as u32) as i32;
        let cy = y_lo + (rng(seed, 0, k, 0, SALT_GEN_WORM_Y) % (y_hi - y_lo).max(1) as u32) as i32;
        if cy + r >= h - 8 || (cy - r..=cy + r).any(|y| (x - r..=x + r).any(|xx| g.mat[(y * w + xx) as usize] != ROCK)) {
            continue;
        }
        let y = cy + 2;
        if arena.is_some_and(|a| a.contains(x, cy, ARENA_KEEP_OUT)) {
            continue;
        }
        if pickups.iter().any(|&(px, py)| (i32::from(px) - x).abs() < 8 && (i32::from(py) - y).abs() < 8) {
            continue;
        }
        if all.iter().any(|&(ox, oy, _)| (i32::from(ox) - x).abs() < 20 && (i32::from(oy) - y).abs() < 20) {
            continue;
        }
        all.push((x as u16, y as u16, ENEMY_WORM));
        placed += 1;
    }
}

/// Fire imps (F5): open air in the lower shallow band and the top of the deep band, inside a 13 x 13 pocket of Empty
/// cells (so it never spawns in liquid, gas or against a wall), off the pickups and the spawn column, and apart from
/// every other enemy. `(x, y)` is the feet cell; the 5x4 body stands above it.
fn imp_spots(g: &Grid, seed: u64, sc: &Scale, pickups: &[(u16, u16)], all: &mut Vec<(u16, u16, u8)>, arena: Option<&Arena>) {
    let (w, h) = (g.w as i32, g.h as i32);
    let want = scale_count(w, h, ENEMY_IMPS_L, ENEMY_IMPS_MIN) as usize;
    let (y_lo, y_hi) = ((sc.shallow_top + sc.deep_top) / 2, sc.deep_top + 100);
    let mut placed = 0usize;
    for k in 0..6000u32 {
        if placed >= want {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_IMP_X) % (w - 80) as u32) as i32;
        let y = y_lo + (rng(seed, 0, k, 0, SALT_GEN_IMP_Y) % (y_hi - y_lo).max(1) as u32) as i32;
        if y + 7 >= h || (0..13).any(|i| (0..13).any(|j| g.mat[((y - 6 + j) * w + x - 6 + i) as usize] != EMPTY)) {
            continue;
        }
        if arena.is_some_and(|a| a.contains(x, y, ARENA_KEEP_OUT)) {
            continue;
        }
        if pickups.iter().any(|&(px, py)| (i32::from(px) - x).abs() < 12 && (i32::from(py) - y).abs() < 12) {
            continue;
        }
        if all.iter().any(|&(ox, oy, _)| (i32::from(ox) - x).abs() < 20 && (i32::from(oy) - y).abs() < 20) {
            continue;
        }
        all.push((x as u16, y as u16, ENEMY_IMP));
        placed += 1;
    }
}

/// A floor position where M4 can place a pickup: an Empty cell with solid ground below and headroom.
/// `Sim::new` turns each spot into a pickup entity (state); the spot itself is not kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickupSpot {
    pub x: u16,
    pub y: u16,
    /// 0 = shallow band, 1 = deep band.
    pub band: u8,
    /// `Some(spell)` for the boss supply pile; `None` rolls the band's table.
    pub fixed: Option<u8>,
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

/// True if two sites' ellipses, each grown by `SITE_GAP / 2`, overlap (bounding-box test: conservative, integer).
fn sites_overlap(a: &Site, b: &Site) -> bool {
    (a.cx - b.cx).abs() < a.rx + b.rx + SITE_GAP && (a.cy - b.cy).abs() < a.ry + b.ry + SITE_GAP
}

/// Pick the biome sites (plan section 1): kinds in a fixed order (lava, ice); site `k` of kind `b` tries up to 64
/// candidates, each a path point in the kind's depth band chosen by `rng(seed, 0, k * 64 + t, b, SALT_GEN_BIOME)`.
/// A candidate is rejected if it comes within `near_border`, above the surface margin, in the spawn clearance, overlaps
/// the boss arena grown by `ARENA_KEEP_OUT + rx`, or comes within `SITE_GAP` of an earlier site. A site with no
/// candidate is skipped. At most `sum(count) * 64` draws; a pure function of (seed, size, path, arena).
fn pick_sites(g: &Grid, seed: u64, path: &[(i32, i32)], sc: &Scale, arena: Option<&Arena>) -> Vec<Site> {
    let (w, h) = (g.w as i32, g.h as i32);
    let mut sites: Vec<Site> = Vec::new();
    // Only a path point already open to the sky (a sealed pocket would be filled by `connect_and_prune`).
    let mut open = vec![0u8; g.mat.len()];
    flood(g, &mut open, g.w / 2, &mut Vec::new(), None);
    for (kind, count) in [(BIOME_LAVA, sc.biome_count.0), (BIOME_ICE, sc.biome_count.1)] {
        let (lo, hi) = if kind == BIOME_LAVA {
            (sc.deep_top + scale_u(h, 60), sc.repair_depth - scale_u(h, 80))
        } else {
            (sc.shallow_top, sc.shallow_top + scale_u(h, 300))
        };
        let (rlo, rhi) = if kind == BIOME_LAVA { sc.lava_rx } else { sc.ice_rx };
        let cand: Vec<(i32, i32)> = path.iter().copied().filter(|p| p.1 >= lo && p.1 < hi && open[(p.1 * w + p.0) as usize] != 0).collect();
        if cand.is_empty() {
            continue;
        }
        for k in 0..count as u32 {
            let rx = rlo + (rng(seed, 0, k, u32::from(kind), SALT_GEN_BIOME_R) % (rhi - rlo + 1) as u32) as i32;
            let ry = if kind == BIOME_LAVA { rx * 2 / 5 } else { rx / 2 };
            for t in 0..64u32 {
                let (cx, cy) = cand[(rng(seed, 0, k * 64 + t, u32::from(kind), SALT_GEN_BIOME) % cand.len() as u32) as usize];
                let site = Site { kind, cx, cy, rx, ry };
                let ok = cy - ry >= sc.surface_y + 60
                    && cy + ry < h - FLOOR_ROWS as i32 - 12
                    && cx - rx > WALL_COLS as i32 + 12
                    && cx + rx < w - WALL_COLS as i32 - 12
                    && !near_border(g, cx, cy, ry)
                    && !((cx - w / 2).abs() - rx <= ENEMY_SPAWN_CLEAR && cy - ry < sc.shallow_top + ENEMY_SPAWN_ROWS)
                    && !arena.is_some_and(|a| a.contains(cx, cy, ARENA_KEEP_OUT + rx))
                    && !sites.iter().any(|s| sites_overlap(s, &site));
                if ok {
                    sites.push(site);
                    break;
                }
            }
        }
    }
    sites
}

/// Carve each site's cavern: Rock and Dirt inside the ellipse become Empty (like `carve_chambers`). Runs before
/// `connect_and_prune`, so a cavern the worms did not reach is joined or filled like any other open space.
fn carve_sites(g: &mut Grid, sites: &[Site]) {
    let (w, h) = (g.w as i32, g.h as i32);
    let depth = |g: &Grid| box_reach(g, (g.w / 2, 0), FIT_W, FIT_H).map_or(0, |(_, dy)| dy);
    for s in sites {
        let d0 = depth(g);
        let mut bowl: Vec<usize> = Vec::new();
        for y in (s.cy - s.ry).max(0)..=(s.cy + s.ry).min(h - 1) {
            for x in (s.cx - s.rx).max(0)..=(s.cx + s.rx).min(w - 1) {
                let (dx, dy) = (i64::from(x - s.cx), i64::from(y - s.cy));
                if dx * dx * i64::from(s.ry * s.ry) + dy * dy * i64::from(s.rx * s.rx) <= i64::from(s.rx * s.rx) * i64::from(s.ry * s.ry) {
                    let i = (y * w + x) as usize;
                    if y < site_floor(s) {
                        if g.mat[i] == ROCK || g.mat[i] == DIRT {
                            g.mat[i] = EMPTY;
                        }
                    } else if g.mat[i] == EMPTY {
                        // A flat bowl: open space the worms left below the floor row is sealed, so a pool has a basin.
                        g.mat[i] = ROCK;
                        bowl.push(i);
                    }
                }
            }
        }
        // A bowl that seals the route a worm took under the site would push `repair_traversal` to cut elsewhere (even
        // through the boss arena floor): if the walkable depth got shallower, undo the bowl.
        if depth(g) < d0 {
            for &i in &bowl {
                g.mat[i] = EMPTY;
            }
        }
    }
}

/// Dam the low rim of a lava site (after `connect_and_prune`, whose links cut through any earlier dam): Empty cells in the ring just outside the ellipse (grown by 3) at or below 18 rows above
/// its floor become Rock, so a tunnel entering at floor level cannot drain the lake or blow its basin past the pool cap.
fn dam_site(g: &mut Grid, s: &Site) -> Vec<usize> {
    let mut changed = Vec::new();
    let (w, h) = (g.w as i32, g.h as i32);
    let (rx, ry) = (i64::from(s.rx + 3), i64::from(s.ry + 3));
    for y in (site_floor(s) - 18).max(0)..=(s.cy + s.ry + 3).min(h - 1) {
        for x in (s.cx - s.rx - 3).max(0)..=(s.cx + s.rx + 3).min(w - 1) {
            let (dx, dy) = (i64::from(x - s.cx), i64::from(y - s.cy));
            if dx * dx * ry * ry + dy * dy * rx * rx <= rx * rx * ry * ry {
                let i = (y * w + x) as usize;
                if g.mat[i] == EMPTY && !s.inside(x, y) {
                    g.mat[i] = ROCK;
                    changed.push(i);
                }
            }
        }
    }
    changed
}

/// The first solid row of a site's flat floor: the cavern is open above it (like the boss arena's floor).
fn site_floor(s: &Site) -> i32 {
    s.cy + s.ry / 2
}

/// Seal a site's low rim (`dam_site`). A small pocket the dam cuts off from the sky is filled; if it would strand a big
/// region (a tunnel that carries on past the site), undo the dam: reachability comes first.
fn seal_site(g: &mut Grid, s: &Site) {
    let mut seen = vec![0u8; g.mat.len()];
    flood(g, &mut seen, g.w / 2, &mut Vec::new(), None);
    let before = seen.iter().filter(|&&v| v != 0).count();
    let dam = dam_site(g, s);
    seen.fill(0);
    flood(g, &mut seen, g.w / 2, &mut Vec::new(), None);
    let lost = before - dam.len() - seen.iter().filter(|&&v| v != 0).count();
    if lost > DAM_STRAND_MAX {
        for &i in &dam {
            g.mat[i] = EMPTY;
        }
    } else if lost > 0 {
        for i in 0..g.mat.len() {
            if g.mat[i] == EMPTY && seen[i] == 0 && i / g.w >= 100 {
                g.mat[i] = ROCK;
            }
        }
    }
}

/// Lava lakes (plan A1): fill each lava site's basin from the floor under the centre (or a third of the way to either
/// wall if that fails) with a wide, deep pool, Rock lining under it, and two or three Rock ledges jutting from the walls
/// 6-10 rows above the surface so there is somewhere to stand. Runs before `place_lava`, so the ordinary pools,
/// gunpowder and water all respect the lake.
fn fill_lava_lakes(g: &mut Grid, seed: u64, sc: &mut PoolScratch, sites: &[Site], scale: &Scale) {
    let w = g.w as i32;
    let cap = (9000 * scale.pct * scale.pct / 10000) as usize;
    for (n, s) in sites.iter().enumerate().filter(|(_, s)| s.kind == BIOME_LAVA) {
        let n = n as u32;
        seal_site(g, s);
        let mut filled = false;
        let depth = |g: &Grid| box_reach(g, (g.w / 2, 0), FIT_W, FIT_H).map_or(0, |(_, dy)| dy);
        let d0 = depth(g);
        for (j, off) in [0, -s.rx / 3, s.rx / 3].into_iter().enumerate() {
            let x = s.cx + off;
            let Some(yf) = find_floor(g, x, s.cy, s.ry + 4) else { continue };
            if g.mat[(yf * w + x) as usize] != EMPTY || j > 0 && rng(seed, 0, n, j as u32, SALT_GEN_LAKE_X) % 8 == 0 {
                continue;
            }
            if try_pool(g, sc, x, yf, (6, 16), cap, (2 * s.rx + 20) as usize, LAVA, WATER, &[]) {
                // A lake that drowns the route down would make `repair_traversal` cut a tunnel elsewhere (maybe through the
                // boss arena floor): undo any lake that makes the walkable depth shallower.
                if depth(g) < d0 {
                    for &c in &sc.region {
                        g.mat[c as usize] = EMPTY;
                    }
                    continue;
                }
                filled = true;
                break;
            }
        }
        if !filled {
            continue;
        }
        let surface = sc.region.iter().map(|&c| c as usize / g.w).min().unwrap_or(0) as i32;
        for &c in &sc.region {
            let i = c as usize;
            for dy in 1..=2 {
                let j = i + dy * g.w;
                if matches!(g.mat[j], DIRT | SAND) {
                    g.mat[j] = ROCK;
                }
            }
        }
        let ledges = 2 + (rng(seed, 0, n, 7, SALT_GEN_LEDGE) % 2) as i32;
        for l in 0..ledges as u32 {
            let side = if l % 2 == 0 { -1 } else { 1 };
            let len = 12 + (rng(seed, 0, n, 10 + l, SALT_GEN_LEDGE) % 9) as i32;
            let yr = surface - 6 - (rng(seed, 0, n, 20 + l, SALT_GEN_LEDGE) % 5) as i32;
            // Walk out from the centre to the wall at this row, then build inward from it.
            let mut x = s.cx;
            while (x - s.cx).abs() <= s.rx + 4 && x > 0 && x < w - 1 && g.mat[(yr * w + x) as usize] == EMPTY {
                x += side;
            }
            if (x - s.cx).abs() > s.rx + 4 {
                continue;
            }
            for d in 1..=len {
                for y in yr - 2..=yr {
                    let i = (y * w + x - side * d) as usize;
                    if g.mat[i] == EMPTY {
                        g.mat[i] = ROCK;
                    }
                }
            }
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
/// stays under `cap` cells and `max_w` columns wide (70 for the ordinary ponds). `foe` is a liquid that must not touch it.
fn try_pool(g: &mut Grid, sc: &mut PoolScratch, x: i32, yf: i32, depths: (i32, i32), cap: usize, max_w: usize, mat: u8, foe: u8, keep_off: &[(i32, i32)]) -> bool {
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
        if hi - lo > max_w || (mat == WATER && lowest >= DEEP_TOP as usize - 4) {
            continue;
        }
        let touches = sc.region.iter().any(|&c| {
            let i = c as usize;
            [i - 1, i + 1, i - w, i + w].iter().any(|&j| g.mat[j] == foe)
        });
        if touches {
            return false;
        }
        // Keep the whole pool (not just its seed cell) `ACID_PATH_MARGIN` clear of `keep_off`; a shallower
        // level is a smaller region, so try that next.
        if !keep_off.is_empty() && sc.region.iter().any(|&c| near_path(keep_off, c as i32 % w as i32, c as i32 / w as i32, ACID_PATH_MARGIN)) {
            continue;
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
        if try_pool(g, sc, x, yf, (3, depth), 900, 70, WATER, LAVA, &[]) {
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
        if try_pool(g, sc, x, yf, (4, depth), 1800, 70, LAVA, WATER, &[]) {
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

/// The first Empty cell at or below (x, y0) that rests directly on Water: a surface a layered pool can float on.
fn find_water_surface(g: &Grid, x: i32, y0: i32, max_down: i32) -> Option<i32> {
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
    (at(y + 1) == WATER).then_some(y)
}

/// Oil pools in the shallow band: half of the attempts try to float on a Water pool (a layered pool),
/// the rest rest on a floor. Oil keeps away from Lava (`try_pool`'s `foe`).
fn place_oil(g: &mut Grid, seed: u64, sc: &mut PoolScratch, scale: &Scale) {
    let mut placed = 0;
    for k in 0..6000u32 {
        if placed == scale.oil_count {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_OIL_X) % scale.water_x_span as u32) as i32;
        let y = scale.water_y_lo + (rng(seed, 0, k, 0, SALT_GEN_OIL_Y) % scale.water_y_span as u32) as i32;
        let depth = 3 + (rng(seed, 0, k, 0, SALT_GEN_OIL_D) % 5) as i32;
        let layered = rng(seed, 0, k, 1, SALT_GEN_OIL_LAYER) & 1 == 0;
        let yf = if layered { find_water_surface(g, x, y, 120) } else { find_floor(g, x, y, 120) };
        let Some(yf) = yf else { continue };
        if yf >= scale.deep_top - 12 || g.mat[yf as usize * g.w + x as usize] != EMPTY {
            continue;
        }
        if try_pool(g, sc, x, yf, (2, depth), 700, 70, OIL, LAVA, &[]) {
            placed += 1;
        }
    }
}

/// Is (x, y) within `r` cells (Chebyshev) of any point of the guaranteed path?
fn near_path(path: &[(i32, i32)], x: i32, y: i32, r: i32) -> bool {
    path.iter().any(|&(px, py)| (px - x).abs() <= r && (py - y).abs() <= r)
}

/// Acid pools in the deep band, rare, and never near the guaranteed path (a pit of acid on the only way
/// down would be a trap that rewards nothing). Water must not touch them (it would dilute at once).
fn place_acid(g: &mut Grid, seed: u64, sc: &mut PoolScratch, scale: &Scale, path: &[(i32, i32)]) {
    let mut placed = 0;
    for k in 0..12000u32 {
        if placed == scale.acid_count {
            break;
        }
        let x = 40 + (rng(seed, 0, k, 0, SALT_GEN_ACID_X) % scale.water_x_span as u32) as i32;
        let y = scale.deep_top + 20 + (rng(seed, 0, k, 0, SALT_GEN_ACID_Y) % (scale.lava_y_span + 80) as u32) as i32;
        let depth = 3 + (rng(seed, 0, k, 0, SALT_GEN_ACID_D) % 6) as i32;
        let Some(yf) = find_floor(g, x, y, 120) else { continue };
        if yf < scale.deep_top + 20 || g.mat[yf as usize * g.w + x as usize] != EMPTY || near_path(path, x, yf, ACID_PATH_MARGIN) {
            continue;
        }
        if try_pool(g, sc, x, yf, (2, depth), 500, 70, ACID, WATER, path) {
            placed += 1;
        }
    }
}

/// Gas pockets: under the roof of a roomy chamber, fill up to `GAS_POCKET_ROWS` rows beneath the ceiling
/// with Gas (a few hundred cells), but only where the open height below is at least `GAS_MIN_HEIGHT` so a
/// pocket never blocks a walkable passage, and never within reach of Lava (the check covers the pocket's whole
/// extent, `r + 4` columns either side and the rows from above the ceiling to below the pocket).
fn place_gas_pockets(g: &mut Grid, seed: u64, scale: &Scale, path: &[(i32, i32)]) {
    if path.is_empty() {
        return;
    }
    let (w, h) = (g.w as i32, g.h as i32);
    let mut placed = 0;
    for k in 0..400u32 {
        if placed == scale.gas_count {
            break;
        }
        let (px, py) = path[(rng(seed, 0, k, 0, SALT_GEN_GASP_PICK) % path.len() as u32) as usize];
        if py < scale.shallow_top + 40 || py > scale.deep_top + 300 {
            continue;
        }
        let r = 14 + (rng(seed, 0, k, 0, SALT_GEN_GASP_R) % 16) as i32;
        // The ceiling above the path point: the first solid cell going up through the open space.
        let mut cy = py;
        while cy > 1 && g.mat[(cy * w + px) as usize] == EMPTY {
            cy -= 1;
        }
        if g.mat[(cy * w + px) as usize] == EMPTY || py - cy > 60 || near_material(g, px, cy + GAS_POCKET_ROWS + 4, r + 4, GAS_POCKET_ROWS + 14, LAVA) {
            continue;
        }
        let mut put = 0;
        for x in (px - r).max(1)..=(px + r).min(w - 2) {
            // Open height below this column's ceiling, from the first Empty cell under it.
            let mut top = cy;
            while top < h - 2 && top < cy + 8 && g.mat[(top * w + x) as usize] != EMPTY {
                top += 1;
            }
            if g.mat[(top * w + x) as usize] != EMPTY || g.mat[((top - 1) * w + x) as usize] == EMPTY {
                continue;
            }
            let mut open = 0;
            while top + open < h - 2 && open < GAS_MIN_HEIGHT && g.mat[((top + open) * w + x) as usize] == EMPTY {
                open += 1;
            }
            if open < GAS_MIN_HEIGHT {
                continue;
            }
            for y in top..top + GAS_POCKET_ROWS {
                let i = (y * w + x) as usize;
                if g.mat[i] != EMPTY {
                    break;
                }
                g.mat[i] = GAS;
                put += 1;
            }
        }
        if put >= 60 {
            placed += 1;
        }
    }
}

/// Ice caves (plan A2): in each ice site (carved earlier, flat floor), a water pool in the basin (depths 4..=8) whose top
/// two rows become an ice lid, Rock and Dirt within the ellipse grown by 4 that touch open space become Ice, and 3-6 icicles
/// hang from the ceiling. Every Ice cell written here is spent (`aux = 1`): static, never freezes water, not volatile.
/// Only solids become Ice and only Empty cells become icicles/lid (water), and `repair_traversal` still runs after.
fn place_ice(g: &mut Grid, seed: u64, sc: &mut PoolScratch, sites: &[Site]) {
    let w = g.w as i32;
    for (n, s) in sites.iter().enumerate().filter(|(_, s)| s.kind == BIOME_ICE) {
        let n = n as u32;
        let floor = site_floor(s);
        // The pool: from the floor under the centre, else under a third of the way to either wall.
        let mut pooled = false;
        for (j, off) in [0, -s.rx / 3, s.rx / 3].into_iter().enumerate() {
            let x = s.cx + off + (rng(seed, 0, n, j as u32, SALT_GEN_ICE_POOL_X) % 5) as i32 - 2;
            let Some(yf) = find_floor(g, x, s.cy - s.ry / 2, s.ry + 4) else { continue };
            if g.mat[(yf * w + x) as usize] == EMPTY && try_pool(g, sc, x, yf, (4, 8), 3000, (2 * s.rx + 20) as usize, WATER, LAVA, &[]) {
                pooled = true;
                break;
            }
        }
        let lid = if pooled { sc.region.iter().map(|&c| c as usize / g.w).min().unwrap_or(0) } else { 0 };
        if pooled {
            // The lid stops 3 columns short of each shore, so the water under it stays joined to the open cave.
            let lo = sc.region.iter().map(|&c| c as usize % g.w).min().unwrap_or(0) + 3;
            let hi = sc.region.iter().map(|&c| c as usize % g.w).max().unwrap_or(0).saturating_sub(3);
            // Only water inside the cavern is lidded, so a side tunnel that dips into the pool is never capped.
            let inner = Site { rx: s.rx - 6, ry: s.ry - 3, ..*s };
            for &c in &sc.region {
                if c as usize / g.w < lid + 2 && (lo..=hi).contains(&(c as usize % g.w)) && inner.inside((c as usize % g.w) as i32, (c as usize / g.w) as i32) {
                    g.mat[c as usize] = ICE;
                    g.aux[c as usize] = 1;
                }
            }
        }
        // The lining: solids in the ellipse grown by 4 that touch open space.
        let grown = Site { rx: s.rx + 4, ry: s.ry + 4, ..*s };
        for y in (grown.cy - grown.ry).max(1)..=(grown.cy + grown.ry).min(g.h as i32 - 2) {
            for x in (grown.cx - grown.rx).max(1)..=(grown.cx + grown.rx).min(w - 2) {
                let i = (y * w + x) as usize;
                if matches!(g.mat[i], ROCK | DIRT) && grown.inside(x, y) && [i - 1, i + 1, i - g.w, i + g.w].iter().any(|&j| g.mat[j] == EMPTY) {
                    g.mat[i] = ICE;
                    g.aux[i] = 1;
                }
            }
        }
        // Icicles: from the first ceiling cell under a column, 1-2 wide, 3-8 long.
        let count = 3 + (rng(seed, 0, n, 50, SALT_GEN_ICICLE) % 4) as i32;
        for k in 0..count as u32 {
            let x = s.cx - s.rx * 2 / 3 + (rng(seed, 0, n, 60 + k, SALT_GEN_ICICLE) % (s.rx as u32 * 4 / 3 + 1)) as i32;
            let (wd, len) = (1 + (rng(seed, 0, n, 80 + k, SALT_GEN_ICICLE) % 2) as i32, 3 + (rng(seed, 0, n, 100 + k, SALT_GEN_ICICLE) % 6) as i32);
            let Some(top) = (s.cy - s.ry - 4..floor).find(|&y| g.mat[(y * w + x) as usize] == EMPTY) else { continue };
            if !matches!(g.mat[((top - 1) * w + x) as usize], ICE | ROCK | DIRT) {
                continue;
            }
            for dx in 0..wd {
                for y in top..top + len {
                    let i = (y * w + x + dx) as usize;
                    if g.mat[i] != EMPTY || y >= floor {
                        break;
                    }
                    g.mat[i] = ICE;
                    g.aux[i] = 1;
                }
            }
        }
    }
}

/// Coal seams: worm-like veins 3-5 cells thick that replace Rock only, in the shallow and deep bands (Rock only, so
/// they never open or close space), so digging sometimes hits them.
fn place_coal(g: &mut Grid, seed: u64, scale: &Scale) {
    let (w, h) = (g.w as i32, g.h as i32);
    let lo = scale.shallow_top + 20;
    let hi = scale_u(h, 1400);
    for k in 0..scale.coal_count as u32 {
        let mut x = 40 + (rng(seed, 0, k, 0, SALT_GEN_COAL_X) % (w - 80) as u32) as i32;
        let mut y = lo + (rng(seed, 0, k, 0, SALT_GEN_COAL_Y) % (hi - lo).max(1) as u32) as i32;
        let len = 50 + (rng(seed, 0, k, 1, SALT_GEN_COAL_LEN) % 80) as i32;
        let mut dir = (rng(seed, 0, k, 2, SALT_GEN_COAL_DIR) % 8) as i32;
        // Each seam is 3 or 5 cells thick: a disc of radius 1 or 2 stamped along the worm.
        let r = 1 + (rng(seed, 0, k, 3, SALT_GEN_COAL_LEN) % 2) as i32;
        for st in 0..len as u32 {
            for (dx, dy) in (-r..=r).flat_map(|a| (-r..=r).map(move |b| (a, b))).filter(|&(a, b)| a * a + b * b <= r * r + 1) {
                let (cx, cy) = (x + dx, y + dy);
                if cx > 0 && cy > 0 && cx < w - 1 && cy < h - 1 {
                    let i = (cy * w + cx) as usize;
                    if g.mat[i] == ROCK {
                        g.mat[i] = COAL;
                    }
                }
            }
            // Eight headings, turning by at most one step now and then.
            if rng(seed, 0, k, 10 + st, SALT_GEN_COAL_DIR) % 3 == 0 {
                dir = (dir + 7 + (rng(seed, 0, k, 10 + st, SALT_GEN_COAL_LEN) % 3) as i32) % 8;
            }
            let (sx, sy) = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)][dir as usize];
            x = (x + sx).clamp(1, w - 2);
            y = (y + sy).clamp(lo, hi);
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
fn pick_spots(g: &Grid, seed: u64, sc: &Scale, arena: Option<&Arena>) -> Vec<PickupSpot> {
    let w = g.w as i32;
    let mut out: Vec<PickupSpot> = Vec::new();
    for (band, &(y_lo, y_hi, want)) in sc.target_spots.iter().enumerate() {
        let mut n = 0;
        // 4000 tries, not 400: sparse deep caves need the room to find every spot (D-086). 20000 since biomes: a lava
        // lake covers floor in the deep band, and the loop still stops at `want`, so worlds that were full do not move.
        for k in 0..20000u32 {
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
            if arena.is_some_and(|a| a.contains(x, yf, ARENA_KEEP_OUT)) {
                continue;
            }
            if out.iter().any(|s| (i32::from(s.x) - x).abs() < 40 && (i32::from(s.y) - yf).abs() < 40) {
                continue;
            }
            out.push(PickupSpot { x: x as u16, y: yf as u16, band: band as u8, fixed: None });
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

/// Open caverns, each centred on a point a worm already passed through, so every chamber is joined to the
/// tunnel network (`connect_and_prune` and `repair_traversal` then run as before). A few in the shallow band
/// and more in the deep one. Counter-based: chamber `k` of band `b` is a pure function of (seed, k, b).
/// Rock and Dirt only (like worms), so it cannot disturb Bedrock, and it skips centres near the border or the
/// surface. Runs before the materials are placed, so piles and pools land in the opened space or on its floor.
fn carve_chambers(g: &mut Grid, seed: u64, path: &[(i32, i32)], sc: &Scale) {
    let (w, h) = (g.w as i32, g.h as i32);
    for band in 0..2u32 {
        let (lo, hi) = if band == 0 { (sc.shallow_top, sc.deep_top) } else { (sc.deep_top, sc.repair_depth) };
        let count = if band == 0 { sc.chambers.0 } else { sc.chambers.1 };
        for k in 0..count as u32 {
            let span = (sc.chamber_r.1 - sc.chamber_r.0 + 1) as u32;
            let rx = sc.chamber_r.0 + (rng(seed, 0, k, band, SALT_GEN_CHAMBER) % span) as i32;
            let ry = rx * 2 / 3;
            let ok = |p: &&(i32, i32)| {
                p.1 >= lo && p.1 < hi && p.1 - ry >= sc.surface_y + 60 && p.1 + ry < h - FLOOR_ROWS as i32 - 12
                    && p.0 - rx > WALL_COLS as i32 + 12 && p.0 + rx < w - WALL_COLS as i32 - 12
            };
            let n = path.iter().filter(ok).count();
            if n == 0 {
                continue;
            }
            let pick = (rng(seed, 0, k, band + 2, SALT_GEN_CHAMBER) % n as u32) as usize;
            let &(cx, cy) = path.iter().filter(ok).nth(pick).unwrap_or(&(0, 0));
            for y in (cy - ry).max(0)..=(cy + ry).min(h - 1) {
                for x in (cx - rx).max(0)..=(cx + rx).min(w - 1) {
                    let (dx, dy) = (i64::from(x - cx), i64::from(y - cy));
                    if dx * dx * i64::from(ry * ry) + dy * dy * i64::from(rx * rx) <= i64::from(rx * rx) * i64::from(ry * ry) {
                        let i = (y * w + x) as usize;
                        if g.mat[i] == ROCK || g.mat[i] == DIRT {
                            g.mat[i] = EMPTY;
                        }
                    }
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
/// Chamber radii at L (cells); each is an ellipse two thirds as tall as wide.
const CHAMBER_R_MIN: i32 = 25;
const CHAMBER_R_MAX: i32 = 45;

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
            if matches!(g.mat[i], WATER | LAVA | OIL | ACID) && g.mat[i + w] == EMPTY {
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
            let open = |m: u8| matches!(m, EMPTY | WATER | LAVA | SAND | GUNPOWDER | OIL | ACID | GAS);
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
        let band = |p: &crate::entities::Pickup| u8::from(crate::tuning::PICKUP_TABLE[1].iter().any(|&(k, _)| k == p.spell));
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
                let deep = |p: &crate::entities::Pickup| crate::tuning::PICKUP_TABLE[1].iter().any(|&(k, _)| k == p.spell);
                sh += s.pickups.iter().filter(|p| !deep(p)).count();
                dp += s.pickups.iter().filter(|p| deep(p)).count();
            }
            out += &format!("size {size}: best {} ms, open {}% avg, pickups/seed shallow {} deep {}\n", best / 1000, open / 4, sh / 4, dp / 4);
        }
        std::fs::write("/tmp/f1-gen.txt", out).unwrap();
    }

    /// Measurement: counts of each new material per seed at L, and gen time per size. `--ignored`; writes /tmp/f2-gen.txt.
    #[test]
    #[ignore = "measurement"]
    fn measure_f2_counts() {
        use crate::config::RoomConfig;
        let mut out = String::new();
        for size in 0u8..=2 {
            let cfg = RoomConfig { size, ..RoomConfig::caves_pvp() };
            let mut best = u128::MAX;
            for seed in 1..=8u64 {
                let t = std::time::Instant::now();
                let s = Sim::new(seed, cfg).unwrap();
                best = best.min(t.elapsed().as_micros());
                let n = |m: u8| s.grid.mat.iter().filter(|&&c| c == m).count();
                let open = s.grid.mat.iter().filter(|&&m| m == EMPTY).count() * 100 / s.grid.mat.len();
                out += &format!("size {size} seed {seed}: oil {} acid {} gas {} ice {} coal {} open {open}%\n", n(OIL), n(ACID), n(GAS), n(ICE), n(COAL));
            }
            out += &format!("size {size}: best gen {} ms\n", best / 1000);
        }
        std::fs::write("/tmp/f2-gen.txt", out).unwrap();
    }

    /// Acid never sits within `ACID_PATH_MARGIN` of the worm path, and every new material the generator places
    /// is one `paintable` can represent. Shown red by letting `place_acid` ignore the path.
    #[test]
    fn acid_stays_off_the_path_and_gen_materials_are_paintable() {
        use crate::config::RoomConfig;
        for seed in 1..=3u64 {
            let s = Sim::new(seed, RoomConfig::caves_pvp()).unwrap();
            assert!(s.grid.mat.iter().all(|&m| m == BEDROCK || paintable(m)));
            let acid: usize = s.grid.mat.iter().filter(|&&m| m == ACID).count();
            assert!(acid > 0, "seed {seed}: no acid");
        }
        // Direct: a path point inside the pool's reach rejects the pool.
        let mut g = Grid::new(400, 300);
        for i in 0..g.mat.len() {
            g.mat[i] = ROCK;
        }
        for y in 100..140 {
            for x in 50..100 {
                g.mat[y * 400 + x] = EMPTY;
            }
        }
        let mut sc = Scale::new(2048, 1536);
        sc.acid_count = 3;
        sc.lava_y_lo = 100;
        sc.lava_y_span = 30;
        sc.water_x_span = 60;
        sc.deep_top = 0;
        let mut ps = PoolScratch { mark: vec![0u8; g.mat.len()], stack: Vec::new(), region: Vec::new() };
        let path: Vec<(i32, i32)> = (0..50).step_by(8).map(|k| (50 + k, 120)).collect();
        place_acid(&mut g, 1, &mut ps, &sc, &path);
        assert_eq!(g.mat.iter().filter(|&&m| m == ACID).count(), 0, "acid must keep off the path");
        place_acid(&mut g, 1, &mut ps, &sc, &[]);
        assert!(g.mat.iter().filter(|&&m| m == ACID).count() > 0, "with no path the same call places acid");
    }

    /// On real worlds, no Acid cell is within `ACID_PATH_MARGIN` (Chebyshev) of the worm path, measured here
    /// with a separate distance check rather than the generator's `near_path`. Cells the repair pass cleared
    /// are gone, so this checks what is left. Shown red with the whole-pool check removed.
    #[test]
    fn acid_pools_keep_the_whole_pool_off_the_path() {
        use crate::config::RoomConfig;
        let mut total = 0;
        for size in 0u8..=2 {
            let (w, h) = RoomConfig { size, ..RoomConfig::caves_pvp() }.dims();
            for seed in 1..=8u64 {
                let mut g = Grid::new(w as usize, h as usize);
                let (_, path) = generate_with_path(&mut g, seed);
                for (i, &m) in g.mat.iter().enumerate() {
                    if m != ACID {
                        continue;
                    }
                    total += 1;
                    let (x, y) = ((i % g.w) as i32, (i / g.w) as i32);
                    let d = path.iter().map(|&(px, py)| (px - x).abs().max((py - y).abs())).min().unwrap();
                    assert!(d > ACID_PATH_MARGIN, "size {size} seed {seed}: acid at ({x},{y}) is {d} from the path");
                }
            }
        }
        assert!(total > 0, "no acid at all, the test checks nothing");
    }

    /// No generated Gas cell is within `GAS_LAVA_TEST_MARGIN` cells (Chebyshev) of Lava, on every size and seeds
    /// 1-8. Lava ignites Gas, so a pocket touching lava would flash before anyone arrives.
    #[test]
    fn gas_pockets_keep_clear_of_lava() {
        use crate::config::RoomConfig;
        const GAS_LAVA_TEST_MARGIN: i32 = 3;
        let mut gas_total = 0;
        for size in 0u8..=2 {
            let (w, h) = RoomConfig { size, ..RoomConfig::caves_pvp() }.dims();
            for seed in 1..=8u64 {
                let mut g = Grid::new(w as usize, h as usize);
                generate(&mut g, seed);
                for (i, &m) in g.mat.iter().enumerate() {
                    if m != GAS {
                        continue;
                    }
                    gas_total += 1;
                    let (x, y) = ((i % g.w) as i32, (i / g.w) as i32);
                    assert!(!near_material(&g, x, y, GAS_LAVA_TEST_MARGIN, GAS_LAVA_TEST_MARGIN, LAVA), "size {size} seed {seed}: gas at ({x},{y}) within {GAS_LAVA_TEST_MARGIN} of lava");
                }
            }
        }
        assert!(gas_total > 0, "no gas generated, the test checks nothing");
    }

    /// A pocket's whole extent is checked against Lava, not one point: lava just outside the old 14-cell box but
    /// inside the pocket (radius 14-29) must stop the pocket. Red with the old single-point check.
    #[test]
    fn gas_pocket_rejected_when_its_edge_touches_lava() {
        let build = |lava: bool| {
            let mut g = Grid::new(400, 300);
            for i in 0..g.mat.len() {
                g.mat[i] = ROCK;
            }
            for y in 100..200 {
                for x in 50..350 {
                    g.mat[y * 400 + x] = EMPTY;
                }
            }
            if lava {
                for y in 100..115 {
                    g.mat[y * 400 + 216] = LAVA; // 16 cells right of the path point, outside the old 14-cell box
                }
            }
            g
        };
        let mut sc = Scale::new(2048, 1536);
        sc.shallow_top = 0;
        sc.deep_top = 1000;
        sc.gas_count = 1;
        let path = [(200, 130)];
        let mut g = build(false);
        place_gas_pockets(&mut g, 1, &sc, &path);
        assert!(g.mat.iter().filter(|&&m| m == GAS).count() >= 60, "control: a pocket is placed without lava");
        let mut g = build(true);
        place_gas_pockets(&mut g, 1, &sc, &path);
        assert_eq!(g.mat.iter().filter(|&&m| m == GAS).count(), 0, "no pocket may reach the lava");
    }

    /// `carve_chambers` opens big ellipses centred on worm-path points, inside the walls and bands, Rock and Dirt
    /// only, as a pure function of (seed, path). Shown red with the function returning early.
    #[test]
    fn chambers_open_roomy_caverns_on_the_path() {
        let (w, h) = (2048i32, 1536i32);
        let fresh = || {
            let mut g = Grid::new(w as usize, h as usize);
            for i in 0..g.mat.len() {
                g.mat[i] = ROCK;
            }
            g
        };
        let mut g = fresh();
        let sc = Scale::new(w, h);
        let path: Vec<(i32, i32)> = (0..40).map(|k| (200 + k * 40, sc.shallow_top + 100 + k * 25)).collect();
        carve_chambers(&mut g, 5, &path, &sc);
        let open = g.mat.iter().filter(|&&m| m == EMPTY).count();
        // 4 shallow + 8 deep ellipses of radius 25-45 (area pi*rx*(2/3)rx): well over 20k cells.
        assert!(open > 20_000, "{open} cells opened");
        for y in 0..g.h {
            for x in 0..g.w {
                if g.mat[y * g.w + x] == EMPTY {
                    assert!(x >= WALL_COLS && x < g.w - WALL_COLS && y < g.h - FLOOR_ROWS && y >= sc.surface_y as usize, "opened {x},{y}");
                }
            }
        }
        let mut g2 = fresh();
        carve_chambers(&mut g2, 5, &path, &sc);
        assert!(g2.mat == g.mat, "carve_chambers must be a pure function of (seed, path)");
    }
}
