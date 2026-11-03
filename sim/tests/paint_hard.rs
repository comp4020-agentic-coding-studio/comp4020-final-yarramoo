//! Fix B item 2: a Paint stroke of a structural material records no crumble seeds, so painted rock may float
//! and never frees the dirt it encloses; a stroke of anything else still does.
use sim::input::encode_paint;
use sim::materials::*;
use sim::sim::Sim;

/// A dirt slab (y 100..300, whole width) that reaches the world edge, so it is anchored. The stroke is a ring
/// of radius 12 painted as 24 short segments; the dirt inside the ring is cut off from the slab.
fn ring(mat: u8, sleeping: bool) -> Sim {
    let mut s = Sim::new(1, 0).unwrap(); // classic sandbox: Paint allowed, empty box
    let w = s.grid.w;
    for y in 100..300 {
        for x in 0..w {
            s.grid.mat[y * w + x] = DIRT;
        }
    }
    s.grid.sleep_enabled = sleeping;
    let pts: Vec<(i16, i16)> = (0..=36)
        .map(|k| {
            let a = k as f64 * std::f64::consts::TAU / 36.0;
            ((200.0 + 10.0 * a.cos()) as i16, (200.0 + 10.0 * a.sin()) as i16)
        })
        .collect();
    for p in pts.windows(2) {
        s.push_input(&encode_paint(1, mat, p[0].0, p[0].1, p[1].0, p[1].1, 2));
    }
    for _ in 0..3 {
        s.step();
    }
    s
}

fn inside(s: &Sim, m: u8) -> usize {
    let w = s.grid.w;
    (195..206).flat_map(|y| (195..206).map(move |x| (x, y))).filter(|&(x, y)| s.grid.mat[y * w + x] == m).count()
}

#[test]
fn rock_ring_leaves_the_enclosed_dirt_alone() {
    let s = ring(ROCK, true);
    assert!(inside(&s, DIRT) > 100, "enclosed dirt must survive a Rock stroke, got {}", inside(&s, DIRT));
    assert_eq!(inside(&s, SAND), 0);
}

#[test]
fn sand_ring_still_crumbles_the_enclosed_dirt() {
    let s = ring(SAND, true);
    assert!(inside(&s, DIRT) < 20, "enclosed dirt should have crumbled, {} left", inside(&s, DIRT));
}

#[test]
fn hard_and_soft_paint_are_sleep_invisible() {
    for mat in [ROCK, SAND] {
        let (mut a, mut b) = (ring(mat, true), ring(mat, false));
        for _ in 0..200 {
            a.step();
            b.step();
        }
        assert_eq!(a.state_hash(), b.state_hash(), "mat {mat}");
    }
}
