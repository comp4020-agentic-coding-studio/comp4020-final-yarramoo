//! Biomes slice 1: site picker, lava lakes, ice caves (generation invariants over seeds 1..=8, every size, both presets).
use sim::config::RoomConfig;
use sim::gen::{generate_world, World, BIOME_ICE, BIOME_LAVA};
use sim::grid::Grid;
use sim::materials::*;
use sim::tuning::{ARENA_KEEP_OUT, ENEMY_SPAWN_CLEAR, ENEMY_SPAWN_ROWS};

fn make(size: u8, seed: u64, survival: bool) -> (Grid, World) {
    let cfg = RoomConfig { size, ..if survival { RoomConfig::survival() } else { RoomConfig::caves_pvp() } };
    let (w, h) = cfg.dims();
    let mut g = Grid::new(w, h);
    let world = generate_world(&mut g, seed, cfg.has_enemies());
    (g, world)
}

fn all() -> Vec<(u8, u64, bool, Grid, World)> {
    let mut v = Vec::new();
    for size in 0u8..=2 {
        for seed in 1..=8u64 {
            for survival in [false, true] {
                let (g, w) = make(size, seed, survival);
                v.push((size, seed, survival, g, w));
            }
        }
    }
    v
}

fn count(g: &Grid, m: u8) -> usize {
    g.mat.iter().filter(|&&c| c == m).count()
}

fn kinds(w: &World, kind: u8) -> usize {
    w.sites.iter().filter(|s| s.kind == kind).count()
}

#[test]
fn every_large_and_medium_world_has_a_lava_site_and_an_ice_site() {
    let mut s_counts = Vec::new();
    for (size, seed, sv, g, w) in all() {
        let (l, i) = (kinds(&w, BIOME_LAVA), kinds(&w, BIOME_ICE));
        if size >= 1 {
            assert!(l >= 1 && i >= 1, "size {size} seed {seed} survival {sv}: lava {l} ice {i}");
        } else if !sv {
            s_counts.push((l, i));
        }
        assert!(w.sites.len() <= 6 * 64);
        let _ = g;
    }
    let (lava_any, ice_any) = (s_counts.iter().any(|c| c.0 >= 1), s_counts.iter().any(|c| c.1 >= 1));
    assert!(lava_any && ice_any, "S per-seed (lava, ice) counts: {s_counts:?}");
    std::fs::write("/tmp/b1-s-counts.txt", format!("{s_counts:?}")).unwrap();
}

#[test]
fn sites_do_not_overlap_each_other_the_arena_or_the_spawn() {
    for (size, seed, sv, g, w) in all() {
        let (gw, gh) = (g.w as i32, g.h as i32);
        let _ = gh;
        for (i, a) in w.sites.iter().enumerate() {
            for b in &w.sites[i + 1..] {
                let apart = (a.cx - b.cx).abs() >= a.rx + b.rx + 40 || (a.cy - b.cy).abs() >= a.ry + b.ry + 40;
                assert!(apart, "size {size} seed {seed} sv {sv}: sites {a:?} {b:?} overlap");
            }
            if let Some(ar) = &w.arena {
                assert!(!ar.contains(a.cx, a.cy, ARENA_KEEP_OUT + a.rx), "size {size} seed {seed}: site {a:?} in arena {ar:?}");
            }
            let shallow_top = (260 * (g.h as i32 - 64) / (1536 - 64)) as i32;
            assert!(!((a.cx - gw / 2).abs() - a.rx <= ENEMY_SPAWN_CLEAR && a.cy - a.ry < shallow_top + ENEMY_SPAWN_ROWS), "size {size} seed {seed}: site {a:?} in spawn clearance");
        }
    }
}

#[test]
fn lava_lakes_hold_lava_and_every_liquid_rests_on_something() {
    let mut per_site = Vec::new();
    for (size, seed, sv, g, w) in all() {
        let gw = g.w;
        let lava_in_sites: usize = w
            .sites
            .iter()
            .filter(|s| s.kind == BIOME_LAVA)
            .map(|s| {
                let mut n = 0;
                for y in (s.cy - s.ry).max(0)..=(s.cy + s.ry).min(g.h as i32 - 1) {
                    for x in (s.cx - s.rx).max(0)..=(s.cx + s.rx).min(gw as i32 - 1) {
                        if g.mat[y as usize * gw + x as usize] == LAVA {
                            n += 1;
                        }
                    }
                }
                per_site.push((size, n));
                n
            })
            .sum();
        let _ = (seed, sv, lava_in_sites);
        let total = count(&g, LAVA);
        let cap = 9000 * (g.w * g.h) / (2048 * 1536) * 3 + 12000 * (g.w * g.h) / (2048 * 1536) + 3000;
        assert!(total <= cap, "size {size} seed {seed}: {total} lava cells (cap {cap})");
        for i in 0..g.mat.len() - gw {
            if matches!(g.mat[i], LAVA | WATER) {
                assert_ne!(g.mat[i + gw], EMPTY, "size {size} seed {seed}: floating liquid at {},{}", i % gw, i / gw);
            }
        }
    }
    std::fs::write("/tmp/b1-lava.txt", format!("{per_site:?}")).unwrap();
    for size in 0..=2u8 {
        let want = [150usize, 1000, 1500][size as usize];
        let big = per_site.iter().filter(|p| p.0 == size && p.1 >= want).count();
        let tot = per_site.iter().filter(|p| p.0 == size).count();
        assert!(big * 2 >= tot, "size {size}: only {big} of {tot} lava sites hold {want}+ cells");
    }
}
#[test]
fn generated_ice_is_spent() {
    for (size, seed, _, g, _) in all() {
        for (i, &m) in g.mat.iter().enumerate() {
            if m == ICE {
                assert_eq!(g.aux[i], 1, "size {size} seed {seed}: fresh ice at {},{}", i % g.w, i / g.w);
            }
        }
    }
}

#[test]
fn ice_sites_hold_a_frozen_lake_and_the_world_has_bounded_ice() {
    let mut with_lake = 0;
    let mut total_sites = 0;
    for (size, seed, _, g, w) in all() {
        let ice = count(&g, ICE);
        assert!(ice <= 40000 * (g.w * g.h) / (2048 * 1536) + 4000, "size {size} seed {seed}: {ice} ice cells");
        for s in w.sites.iter().filter(|s| s.kind == BIOME_ICE) {
            total_sites += 1;
            let mut cells = (0usize, 0usize);
            for y in (s.cy - s.ry - 4).max(0)..=(s.cy + s.ry + 4).min(g.h as i32 - 1) {
                for x in (s.cx - s.rx - 4).max(0)..=(s.cx + s.rx + 4).min(g.w as i32 - 1) {
                    match g.mat[y as usize * g.w + x as usize] {
                        ICE => cells.0 += 1,
                        WATER => cells.1 += 1,
                        _ => {}
                    }
                }
            }
            assert!(cells.0 >= 10, "size {size} seed {seed}: ice site {s:?} holds {} ice", cells.0);
            if cells.1 > 0 {
                with_lake += 1;
            }
        }
    }
    std::fs::write("/tmp/b1-ice.txt", format!("{with_lake} of {total_sites} ice sites hold water")).unwrap();
    assert!(with_lake * 2 >= total_sites, "{with_lake} of {total_sites} ice sites hold water");
}
