//! Fix B item 3: crumbled rock becomes Pebbles (id 21), a Sand-like powder that is not structural, not
//! flammable and not paintable. Ice still becomes Water.
use sim::grid::Grid;
use sim::input::encode_paint;
use sim::materials::*;
use sim::sim::Sim;

const N: usize = 256;

fn fill(g: &mut Grid, x0: usize, y0: usize, x1: usize, y1: usize, m: u8) {
    for y in y0..y1 {
        for x in x0..x1 {
            g.mat[y * N + x] = m;
        }
    }
}

fn count(g: &Grid, x0: usize, y0: usize, x1: usize, y1: usize, m: u8) -> usize {
    (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).filter(|&(x, y)| g.mat[y * N + x] == m).count()
}

#[test]
fn pebbles_has_the_agreed_id_and_rules() {
    assert_eq!(PEBBLES, 21);
    assert!(!sim::grid::is_structural(PEBBLES));
    assert!(!is_flammable(PEBBLES));
    assert!(!paintable(PEBBLES));
    assert_eq!(material_class(PEBBLES), CLASS_SOLID);
}

#[test]
fn a_freed_island_crumbles_to_pebbles_not_sand() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 120, N, 124, ROCK);
    fill(&mut g, 100, 100, 105, 105, ROCK);
    fill(&mut g, 102, 105, 103, 120, ROCK);
    g.set(110 * N + 102, EMPTY, 0);
    g.crumble_islands();
    assert_eq!(count(&g, 100, 100, 105, 105, PEBBLES), 25);
    assert_eq!(count(&g, 0, 0, N, N, SAND), 0);
}

#[test]
fn an_ice_island_still_melts_to_water() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 120, N, 124, ROCK);
    fill(&mut g, 100, 100, 105, 105, ICE);
    fill(&mut g, 102, 105, 103, 120, ROCK);
    g.set(110 * N + 102, EMPTY, 0);
    g.crumble_islands();
    assert_eq!(count(&g, 100, 100, 105, 105, WATER), 25);
    assert_eq!(count(&g, 100, 100, 105, 105, PEBBLES), 0, "the ice block itself never becomes pebbles");
}

#[test]
fn pebbles_fall_and_pile_like_sand() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 204, ROCK);
    g.set(50 * N + 128, PEBBLES, 0);
    for t in 0..200 {
        g.step_cells(1, t);
    }
    assert_eq!(g.mat[199 * N + 128], PEBBLES, "a lone pebble lands on the floor");
    // A column of 40 spreads into a pile wider than one cell.
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 204, ROCK);
    for y in 100..140 {
        g.set(y * N + 128, PEBBLES, 0);
    }
    for t in 0..600 {
        g.step_cells(1, t);
    }
    assert_eq!(count(&g, 0, 0, N, 200, PEBBLES), 40);
    assert!(count(&g, 0, 190, N, 200, PEBBLES) >= 10, "pebbles must pile out sideways");
}

#[test]
fn pebbles_are_not_paintable() {
    let mut s = Sim::new(1, 0).unwrap();
    s.push_input(&encode_paint(1, PEBBLES, 100, 100, 100, 100, 4));
    s.step();
    assert_eq!(s.grid.mat[100 * s.grid.w + 100], EMPTY);
}
