//! world-life W1: surface greenery from generation (canopies, shrubs, wildflowers), existing cells only.
use sim::config::RoomConfig;
use sim::input::encode_join;
use sim::sim::Sim;

const STEM: u8 = 8;
const FLOWER: u8 = 9;
const WOOD: u8 = 6;
/// Fewest leaf cells within radius 8 of a trunk top: a canopy of rx >= 5 is at least ~90 cells before ragged edges.
const CANOPY_MIN: usize = 25;

fn worlds() -> Vec<(String, Sim)> {
    let mut v = Vec::new();
    for (name, base) in [("pvp", RoomConfig::caves_pvp()), ("survival", RoomConfig::survival())] {
        for size in 0u8..=2 {
            for seed in 1..=8u64 {
                v.push((format!("{name} size {size} seed {seed}"), Sim::new(seed, RoomConfig { size, ..base.clone() }).unwrap()));
            }
        }
    }
    v
}

fn at(s: &Sim, x: i32, y: i32) -> u8 {
    s.grid.mat[y as usize * s.grid.w + x as usize]
}

/// Topmost Wood cell of each trunk: Wood with Wood below it and no Wood above (branches are one cell wide and
/// diagonal, so require a 2-wide column of Wood three high).
fn trunk_tops(s: &Sim) -> Vec<(i32, i32)> {
    let w = s.grid.w as i32;
    let mut out = Vec::new();
    for x in 40..w - 40 {
        for y in 3..ground(s, x) {
            let wood = |dx: i32, dy: i32| at(s, x + dx, y + dy) == WOOD;
            if wood(0, 0) && wood(1, 0) && wood(0, 1) && wood(1, 1) && wood(0, 2) && wood(1, 2) && !wood(0, -1) && !wood(1, -1) {
                out.push((x, y));
                break;
            }
        }
    }
    out
}

/// Surface row of a column: the first Dirt cell from the top.
fn ground(s: &Sim, x: i32) -> i32 {
    (0..s.grid.h as i32).find(|&y| matches!(at(s, x, y), 1..=4)).unwrap()
}

#[test]
fn every_tree_has_a_canopy() {
    let mut bad = Vec::new();
    let mut trees = 0;
    for (name, s) in worlds() {
        for (x, y) in trunk_tops(&s) {
            trees += 1;
            let mut n = 0;
            for dy in -8..=8 {
                for dx in -8..=8 {
                    if dx * dx + dy * dy <= 64 && matches!(at(&s, x + dx, (y + dy).max(0)), STEM | FLOWER) {
                        n += 1;
                    }
                }
            }
            if n < CANOPY_MIN {
                bad.push(format!("{name}: trunk at {x},{y} has {n} leaf cells"));
            }
        }
    }
    assert!(trees > 100, "only {trees} trees found");
    assert!(bad.is_empty(), "{bad:?}");
}

#[test]
fn generated_plants_are_static_and_start_with_aux_zero() {
    for (name, s) in worlds() {
        for (i, &m) in s.grid.mat.iter().enumerate() {
            if m == STEM || m == FLOWER {
                assert_eq!(s.grid.aux[i], 0, "{name}: plant at {} {} has aux {}", i % s.grid.w, i / s.grid.w, s.grid.aux[i]);
            }
        }
    }
}

#[test]
fn surface_has_shrubs_and_tufts_and_none_in_the_spawn_columns() {
    for (name, s) in worlds() {
        let (w, h) = (s.grid.w as i32, s.grid.h as i32);
        let mut on_ground = 0;
        // Trees may stand in the spawn columns (the spawn scan skips them), so their crowns are not counted there.
        let trunks: Vec<i32> = trunk_tops(&s).iter().map(|t| t.0).collect();
        for x in 40..w - 40 {
            let g = ground(&s, x);
            // plant cells resting directly on the surface Dirt
            if matches!(at(&s, x, g - 1), STEM | FLOWER) {
                on_ground += 1;
            }
            if (x - w / 2).abs() <= 48 + 7 * 16 + 8 && !trunks.iter().any(|&t| (t - x).abs() <= 12) {
                // Crowns hang 12 or more rows above the ground (the avatar's clearance); shrubs and tufts sit below that.
                for y in (g - 11).max(0)..g.min(h) {
                    assert!(!matches!(at(&s, x, y), STEM | FLOWER), "{name}: plant over spawn column {x} at row {y}");
                }
            }
        }
        // Plant columns resting on the surface, seen over seeds 1..=8: size S 15-57, M 109-120, L 439-460. The floor is 10.
        assert!(on_ground >= 10, "{name}: only {on_ground} plant columns on the ground");
    }
}

#[test]
fn spawn_still_lands_on_dirt_or_rock_with_a_clear_box() {
    for (name, mut s) in worlds() {
        for id in 1..=8u32 {
            s.push_input(&encode_join(id));
        }
        s.step();
        for p in s.players.iter().filter(|p| p.active) {
            let (gx, gy) = (p.x >> sim::tuning::POS_SHIFT, p.y >> sim::tuning::POS_SHIFT);
            assert!(matches!(at(&s, gx, gy), 2 | 3), "{name}: player {} spawned on {}", p.id, at(&s, gx, gy));
            for y in gy - 10..gy {
                for x in gx - 2..=gx + 2 {
                    assert_eq!(at(&s, x, y), 0, "{name}: player {} spawn box blocked at {x},{y} by {}", p.id, at(&s, x, y));
                }
            }
        }
    }
}

#[test]
fn stepping_with_sleep_on_and_off_hashes_the_same() {
    for (cfg, seed) in [(RoomConfig::caves_pvp(), 3u64), (RoomConfig::survival(), 5)] {
        let run = |sleep: bool| {
            let mut s = Sim::new(seed, RoomConfig { size: 0, ..cfg.clone() }).unwrap();
            s.grid.sleep_enabled = sleep;
            for _ in 0..600 {
                s.step();
            }
            s.state_hash()
        };
        assert_eq!(run(true), run(false));
    }
}
