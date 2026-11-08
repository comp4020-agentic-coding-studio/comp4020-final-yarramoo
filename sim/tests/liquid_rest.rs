//! Playtest note 4 (3 Nov): a lone liquid cell on flat ground random-walked forever and kept its chunk
//! awake. Liquids need a resting state: a lone cell or a 1-deep film on a flat floor stops moving and
//! its chunk sleeps (`ran_chunks` drops to 0).
use sim::grid::Grid;
use sim::materials::*;

const W: usize = 128;
const H: usize = 128;

fn floor() -> Grid {
    let mut g = Grid::new(W, H);
    g.set_all_active();
    g.sleep_enabled = true;
    for x in 0..W {
        g.set((H - 1) * W + x, BEDROCK, 0);
    }
    g
}

/// Run `n` ticks from `t0`; returns the tick after.
fn run(g: &mut Grid, t0: u32, n: u32) -> u32 {
    for t in t0..t0 + n {
        g.step_cells(9, t);
    }
    t0 + n
}

/// After a settle time, 200 further ticks must change nothing and run no chunk at all.
fn assert_rests(g: &mut Grid, what: &str) {
    let t = run(g, 0, 600);
    let before = g.mat.clone();
    let mut ran = 0;
    for tt in t..t + 200 {
        g.step_cells(9, tt);
        ran += g.ran_chunks;
    }
    assert!(g.mat == before, "{what}: still moving after 600 ticks");
    assert_eq!(ran, 0, "{what}: its chunk never went to sleep ({ran} chunk runs in 200 ticks)");
}

#[test]
fn a_lone_water_cell_on_a_floor_comes_to_rest() {
    let mut g = floor();
    g.set(100 * W + 60, WATER, 0);
    assert_rests(&mut g, "lone water");
}

#[test]
fn a_lone_lava_cell_on_a_floor_comes_to_rest() {
    let mut g = floor();
    g.set(100 * W + 60, LAVA, 0);
    assert_rests(&mut g, "lone lava");
}

#[test]
fn a_lone_oil_and_acid_cell_stop_moving() {
    for m in [OIL, ACID] {
        let mut g = floor();
        g.set(100 * W + 60, m, 0);
        run(&mut g, 0, 600);
        let before = g.mat.clone();
        run(&mut g, 600, 200);
        assert!(g.mat == before, "material {m} still moving after 600 ticks");
    }
}

#[test]
fn a_one_deep_water_film_comes_to_rest() {
    let mut g = floor();
    for x in 40..80 {
        g.set((H - 2) * W + x, WATER, 0);
    }
    assert_rests(&mut g, "water film");
}

#[test]
fn a_one_deep_lava_film_comes_to_rest() {
    let mut g = floor();
    for x in 40..80 {
        g.set((H - 2) * W + x, LAVA, 0);
    }
    assert_rests(&mut g, "lava film");
}

/// The rule must not strand a body that has somewhere to fall: a 4-deep pool on a ledge still pours over
/// the edge and settles to a film (a 1-deep film itself clings, like a droplet).
#[test]
fn a_pool_on_a_ledge_still_pours_over_the_edge() {
    let mut g = floor();
    for x in 30..70 {
        g.set((H - 20) * W + x, ROCK, 0);
    }
    for y in H - 25..H - 20 {
        for x in 30..70 {
            g.set(y * W + x, WATER, 0);
        }
    }
    run(&mut g, 0, 3000);
    let below = (0..W).filter(|&x| g.mat[(H - 2) * W + x] == WATER).count();
    let on_ledge = (30..70).filter(|&x| (H - 25..H - 20).any(|y| g.mat[y * W + x] == WATER)).count();
    assert!(below >= 5 && on_ledge <= 40, "pool did not pour: {below} on the floor, {on_ledge} ledge columns wet");
    let rows = |x: usize| (H - 25..H - 20).filter(|&y| g.mat[y * W + x] == WATER).count();
    assert!((30..70).all(|x| rows(x) <= 2), "ledge not drained to a film");
}

/// Resting liquid wakes when the ground beside it goes, across a chunk edge. The drop rests at x = 63 (the
/// last column of chunk 0) on a shelf; the shelf cell diagonally below it, at x = 64, is in the next chunk.
/// Removing it must wake chunk 0 (through `touch`'s one-cell radius) so the drop takes the diagonal, with
/// sleeping on exactly as with it off. The drop must really fall: a test where nothing moves proves nothing.
#[test]
fn a_resting_cell_wakes_when_the_floor_beside_it_goes_across_a_chunk_edge() {
    let run_it = |sleep: bool| {
        let mut g = floor();
        g.sleep_enabled = sleep;
        for x in 40..=70 {
            g.set((H - 2) * W + x, ROCK, 0);
        }
        g.set((H - 3) * W + 63, WATER, 0);
        let t = run(&mut g, 0, 300);
        assert_eq!(g.mat[(H - 3) * W + 63], WATER, "the drop should be resting where it was put");
        g.set((H - 2) * W + 64, EMPTY, 0);
        run(&mut g, t, 300);
        assert_ne!(g.mat[(H - 3) * W + 63], WATER, "the drop never moved after its floor went (sleep {sleep})");
        g.mat
    };
    assert!(run_it(true) == run_it(false), "sleeping changed the result (invariant 8)");
}
