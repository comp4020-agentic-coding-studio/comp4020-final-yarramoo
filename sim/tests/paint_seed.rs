//! Fix B item 4: Seed strokes sprinkle, and Stem and Flower cannot be painted.
use sim::input::encode_paint;
use sim::materials::*;
use sim::sim::Sim;

fn painted(mat: u8, r: u8, sleeping: bool) -> Sim {
    let mut s = Sim::new(1, 0).unwrap();
    s.grid.sleep_enabled = sleeping;
    s.push_input(&encode_paint(1, mat, 200, 200, 200, 200, r));
    s.step();
    s
}

fn count(s: &Sim, m: u8) -> usize {
    s.grid.mat.iter().filter(|&&c| c == m).count()
}

#[test]
fn stem_and_flower_cannot_be_painted() {
    for m in [STEM, FLOWER] {
        assert!(!paintable(m));
        let s = painted(m, 4, true);
        assert_eq!(count(&s, m), 0, "material {m}");
    }
}

#[test]
fn seed_stroke_sprinkles_a_few_cells_deterministically() {
    // Seeds fall under gravity (they are Seed, a plain solid cell here: counted right after the tick).
    for (r, area) in [(4u8, 49usize), (16, 797)] {
        let (a, b) = (painted(SEED, r, true), painted(SEED, r, true));
        let n = count(&a, SEED);
        assert_eq!(n, count(&b, SEED));
        assert_eq!(a.grid.mat, b.grid.mat, "deterministic");
        assert!(n >= 1 && n * 4 < area, "r={r}: {n} seeds of a {area}-cell disc");
    }
}

#[test]
fn seed_stroke_is_sleep_invisible() {
    let (mut a, mut b) = (painted(SEED, 8, true), painted(SEED, 8, false));
    for _ in 0..200 {
        a.step();
        b.step();
    }
    assert_eq!(a.state_hash(), b.state_hash());
}
