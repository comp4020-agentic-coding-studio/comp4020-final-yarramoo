//! Biomes slice 2: Brick (22), Moss (23), Mushroom (24): ids, rules, fire, acid, dig, paint.
use sim::grid::{is_structural, Grid};
use sim::input::{encode_paint, encode_paint_mode};
use sim::materials::*;
use sim::sim::Sim;

const N: usize = 64;

#[test]
fn ids_and_rules_are_pinned() {
    assert_eq!((BRICK, MOSS, MUSHROOM), (22, 23, 24));
    assert!(is_structural(BRICK) && !is_structural(MOSS) && !is_structural(MUSHROOM));
    assert!(!is_flammable(BRICK) && is_flammable(MOSS) && is_flammable(MUSHROOM));
    for m in [BRICK, MOSS, MUSHROOM] {
        assert!(paintable(m), "{m} paintable");
        assert_eq!(material_class(m), CLASS_SOLID);
    }
    assert!(!paintable(THERMITE + 1));
}

/// A fire cell on each side of a row of `m`, a floor of bedrock; count how many `m` cells burn (are no longer `m`)
/// over a fixed number of ticks, summed over a few seeds.
fn burnt(m: u8) -> usize {
    let mut total = 0;
    for seed in 1..=6u64 {
        let mut g = Grid::new(N, N);
        for x in 0..N {
            g.set((N - 1) * N + x, BEDROCK, 0);
        }
        for x in 10..50 {
            g.set((N - 2) * N + x, m, 0);
        }
        // Fire that lasts: a pair of lit cells re-set every tick would be cheating, so one fire cell per end only.
        g.set((N - 3) * N + 10, FIRE, 0);
        g.set((N - 3) * N + 49, FIRE, 0);
        for t in 0..120 {
            g.step_cells(seed, t);
        }
        total += (10..50).filter(|&x| g.mat[(N - 2) * N + x] != m).count();
    }
    total
}

#[test]
fn moss_burns_much_more_slowly_than_wood_and_mushroom_faster() {
    let (wood, moss, mush) = (burnt(WOOD), burnt(MOSS), burnt(MUSHROOM));
    std::fs::write("/tmp/b2-burn.txt", format!("wood {wood} moss {moss} mushroom {mush}")).unwrap();
    assert!(wood > 0 && moss > 0, "wood {wood} moss {moss}");
    assert!(wood >= 2 * moss, "wood {wood} should burn at least twice as much as moss {moss}");
    assert!(mush > wood, "mushroom {mush} (1 in 6) burns more than wood {wood} (1 in 12)");
    assert_eq!(burnt(BRICK), 0);
}

fn acid_over(m: u8) -> (usize, usize) {
    let mut g = Grid::new(N, N);
    for x in 0..N {
        g.set((N - 1) * N + x, BEDROCK, 0);
    }
    for y in 50..62 {
        for x in 20..30 {
            g.set(y * N + x, m, 0);
        }
    }
    for y in 30..50 {
        for x in 22..28 {
            g.set(y * N + x, ACID, 0);
        }
    }
    let n0 = g.mat.iter().filter(|&&c| c == m).count();
    for t in 0..400 {
        g.step_cells(3, t);
    }
    (n0, g.mat.iter().filter(|&&c| c == m).count())
}

#[test]
fn acid_leaves_brick_and_eats_moss() {
    let (b0, b1) = acid_over(BRICK);
    assert_eq!(b0, b1, "acid must not touch brick");
    let (m0, m1) = acid_over(MOSS);
    assert!(m1 < m0, "acid should eat moss ({m0} -> {m1})");
}

#[test]
fn dig_and_blast_clear_the_new_solids() {
    for m in [BRICK, MOSS, MUSHROOM] {
        let mut g = Grid::new(N, N);
        for y in 20..30 {
            for x in 20..30 {
                g.set(y * N + x, m, 0);
            }
        }
        g.dig(10, 25, 25, 25, 3);
        assert_eq!(g.mat[25 * N + 25], EMPTY, "dig clears {m}");
        g.carve(22, 22, 3, 1, 1);
        assert_eq!(g.mat[22 * N + 22], EMPTY, "blast clears {m}");
    }
}

#[test]
fn painting_each_new_id_works_and_fill_empty_does_not_overwrite_them() {
    for m in [BRICK, MOSS, MUSHROOM] {
        let mut s = Sim::new(1, 0).unwrap();
        s.push_input(&encode_paint(1, m, 100, 100, 100, 100, 3));
        s.step();
        let i = 100 * s.grid.w + 100;
        assert_eq!(s.grid.mat[i], m, "paint {m}");
        s.push_input(&encode_paint_mode(1, 4, 100, 100, 100, 100, 3, true));
        s.step();
        assert_eq!(s.grid.mat[i], m, "fill-empty must not overwrite {m}");
    }
}
