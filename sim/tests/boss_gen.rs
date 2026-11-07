//! F6 commit 1: the boss arena's generation (Survival only), its supply pile and reachability.
use sim::config::RoomConfig;
use sim::sim::Sim;

fn fnv(bytes: &[u8], mut h: u64) -> u64 {
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// FNV-1a of (mat, aux) of a non-Survival Caves world: the arena must not touch any other mode's terrain.
fn world_hash(size: u8, seed: u64) -> u64 {
    let s = Sim::new(seed, RoomConfig { size, ..RoomConfig::caves_pvp() }).unwrap();
    fnv(&s.grid.aux, fnv(&s.grid.mat, 0xcbf2_9ce4_8422_2325))
}

#[test]
fn non_survival_worlds_are_byte_for_byte_unchanged() {
    let got: Vec<u64> = [(0u8, 1u64), (1, 2), (2, 1)].iter().map(|&(z, sd)| world_hash(z, sd)).collect();
    // Recorded at world-life W1 (canopies, shrubs, wildflowers); before that at the mine-wood fix (beams placed on the real hall floor); before that at the mine-floor fix (beams and rooms stand on ground); before that at biomes-3 (grotto and mine); before that at biomes-2 (ice floors); before that at biomes-1 (sites, lava lakes, ice caves change every Caves world); before that, before `carve_arena` existed.
    let want: Vec<u64> = vec![6946760717206692577, 2791777480889609280, 14872523714193492904];
    assert_eq!(got, want, "{got:?}");
}

fn survival(size: u8, seed: u64) -> Sim {
    Sim::new(seed, RoomConfig { size, ..RoomConfig::survival() }).unwrap()
}

/// Boxes of `bw` x `bh` Empty cells reachable one cell at a time from the box at the top of the world centre.
/// Returns (reached box tops as a bitmap, the width), keyed by the top-left cell like the generator's own test.
fn reach(s: &Sim, bw: usize, bh: usize) -> Vec<bool> {
    let g = &s.grid;
    let (w, h) = (g.w, g.h);
    let mut ps = vec![0u32; (w + 1) * (h + 1)];
    for y in 0..h {
        for x in 0..w {
            let solid = u32::from(g.mat[y * w + x] != 0);
            ps[(y + 1) * (w + 1) + x + 1] = solid + ps[y * (w + 1) + x + 1] + ps[(y + 1) * (w + 1) + x] - ps[y * (w + 1) + x];
        }
    }
    let fits = |x: usize, y: usize| {
        x + bw <= w && y + bh <= h && {
            let (x1, y1) = (x + bw, y + bh);
            ps[y1 * (w + 1) + x1] + ps[y * (w + 1) + x] == ps[y * (w + 1) + x1] + ps[y1 * (w + 1) + x]
        }
    };
    let mut seen = vec![false; w * h];
    let start = (w / 2, 0usize);
    assert!(fits(start.0, start.1));
    let mut stack = vec![start];
    seen[start.1 * w + start.0] = true;
    while let Some((x, y)) = stack.pop() {
        for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
            if nx < w && ny < h && !seen[ny * w + nx] && fits(nx, ny) {
                seen[ny * w + nx] = true;
                stack.push((nx, ny));
            }
        }
    }
    seen
}

#[test]
fn every_survival_world_has_an_arena_and_no_other_world_does() {
    for size in 0u8..=2 {
        for seed in 1..=8u64 {
            let a = survival(size, seed).arena.unwrap_or_else(|| panic!("size {size} seed {seed}: no arena"));
            assert!(a.rx >= 40 && a.ry >= 24, "{a:?}");
            let pvp = Sim::new(seed, RoomConfig { size, ..RoomConfig::caves_pvp() }).unwrap();
            assert!(pvp.arena.is_none());
        }
    }
    // Arena size per class, for the report.
    let a = |z| survival(z, 1).arena.unwrap();
    assert_eq!((a(2).rx, a(2).ry), (70, 40));
}

#[test]
fn the_arena_is_open_flat_and_liquid_free() {
    for size in 0u8..=2 {
        for seed in 1..=8u64 {
            let s = survival(size, seed);
            let a = s.arena.unwrap();
            let w = s.grid.w as i32;
            let m = sim::tuning::ARENA_KEEP_OUT;
            let mut air = 0;
            for y in a.cy - a.ry - m..=a.cy + a.ry + m {
                for x in a.cx - a.rx - m..=a.cx + a.rx + m {
                    let c = s.grid.mat[(y * w + x) as usize];
                    if a.contains(x, y, m) {
                        assert!(!sim::materials::is_liquid(c) && !sim::materials::is_gas(c) && c != 4 && c != 13, "size {size} seed {seed}: material {c} at {x},{y}");
                    }
                    if a.contains(x, y, 0) && y < a.floor_y && c == 0 {
                        air += 1;
                    }
                }
            }
            assert!(air > a.rx * a.ry, "size {size} seed {seed}: only {air} open cells");
            // the floor row under the middle is solid, flat
            for x in a.cx - a.floor_half_width()..=a.cx + a.floor_half_width() {
                assert!(s.grid.mat[(a.floor_y * w + x) as usize] != 0, "hole in the floor at {x}");
            }
        }
    }
}

#[test]
fn the_arena_centre_is_reachable_from_the_spawn_for_seeds_1_to_8_at_every_size() {
    let mut bad = Vec::new();
    for size in 0u8..=2 {
        for seed in 1..=8u64 {
            let s = survival(size, seed);
            let a = s.arena.unwrap();
            let seen = reach(&s, 6, 11);
            // the boss stands on the floor: a body box resting on the floor under the centre
            let (x, y) = ((a.cx - 3) as usize, (a.floor_y - 11) as usize);
            if !seen[y * s.grid.w + x] {
                bad.push(format!("size {size} seed {seed}"));
            }
        }
    }
    assert!(bad.is_empty(), "arena unreachable: {bad:?}");
}

#[test]
fn normal_enemies_and_the_supply_pile_stay_out_of_the_arena() {
    for size in 0u8..=2 {
        for seed in 1..=8u64 {
            let s = survival(size, seed);
            let a = s.arena.unwrap();
            let m = sim::tuning::ARENA_KEEP_OUT;
            for e in s.enemies.iter().filter(|e| !sim::enemy::is_boss(e.kind)) {
                let (cx, cy) = (e.x >> 4, e.y >> 4);
                assert!(!a.contains(cx, cy - 2, m), "size {size} seed {seed}: enemy {} inside the arena", e.id);
            }
            let pile: Vec<_> = s.pickups.iter().rev().take(sim::tuning::SUPPLY_PILE.len()).collect();
            assert_eq!(pile.len(), 6);
            for p in pile {
                assert!(!a.contains(i32::from(p.x), i32::from(p.y), 0), "pickup inside the arena");
                assert!((i32::from(p.x) - a.cx).abs() <= a.floor_half_width() + sim::tuning::SUPPLY_ALCOVE_W + 2);
                assert!(sim::tuning::SUPPLY_PILE.contains(&p.spell));
                assert_eq!(s.grid.mat[(i32::from(p.y) * s.grid.w as i32 + i32::from(p.x)) as usize], 0);
            }
        }
    }
}

/// S1 (review-f6): the Survival twin of `traversable_to_every_band`: a 6x11 body walks from the surface to the target depth.
#[test]
fn survival_worlds_are_traversable_to_the_bottom_band_and_the_arena_floor_has_no_holes() {
    let mut bad = Vec::new();
    for size in 0u8..=2 {
        for seed in 1..=12u64 {
            let s = survival(size, seed);
            let (w, h) = (s.grid.w as i32, s.grid.h as i32);
            let target = 1380 * (h - 64) / (1536 - 64);
            match sim::gen::box_reach(&s.grid, (s.grid.w / 2, 0), 6, 11) {
                Some((_, y)) if (y + 11) as i32 >= target => {}
                r => bad.push(format!("size {size} seed {seed}: reach {r:?} needs {target}")),
            }
            let a = s.arena.unwrap();
            for x in a.cx - a.floor_half_width()..=a.cx + a.floor_half_width() {
                if s.grid.mat[(a.floor_y * w + x) as usize] == 0 {
                    bad.push(format!("size {size} seed {seed}: hole in the floor at {x}"));
                    break;
                }
            }
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}

/// S2: no real seed may leave a Survival world without an arena (and so without a boss, which makes it unwinnable).
#[test]
fn every_survival_seed_has_an_arena_and_a_boss() {
    let mut missing = Vec::new();
    for (size, n) in [(0u8, 200u64), (1, 40), (2, 8)] {
        for seed in 1..=n {
            let s = survival(size, seed);
            let boss = s.enemies.iter().filter(|e| sim::enemy::is_boss(e.kind)).count();
            if s.arena.is_none() || boss != 1 {
                missing.push((size, seed));
            }
        }
    }
    assert!(missing.is_empty(), "{} worlds without an arena or boss: {missing:?}", missing.len());
}
