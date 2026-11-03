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
#[ignore = "red until the resting rule (2b)"]
fn a_lone_water_cell_on_a_floor_comes_to_rest() {
    let mut g = floor();
    g.set(100 * W + 60, WATER, 0);
    assert_rests(&mut g, "lone water");
}

#[test]
#[ignore = "red until the resting rule (2b)"]
fn a_lone_lava_cell_on_a_floor_comes_to_rest() {
    let mut g = floor();
    g.set(100 * W + 60, LAVA, 0);
    assert_rests(&mut g, "lone lava");
}

#[test]
#[ignore = "red until the resting rule (2b)"]
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
#[ignore = "red until the resting rule (2b)"]
fn a_one_deep_water_film_comes_to_rest() {
    let mut g = floor();
    for x in 40..80 {
        g.set((H - 2) * W + x, WATER, 0);
    }
    assert_rests(&mut g, "water film");
}

#[test]
#[ignore = "red until the resting rule (2b)"]
fn a_one_deep_lava_film_comes_to_rest() {
    let mut g = floor();
    for x in 40..80 {
        g.set((H - 2) * W + x, LAVA, 0);
    }
    assert_rests(&mut g, "lava film");
}

/// The rule must not strand a liquid that has somewhere to fall: a film next to a ledge still drains.
#[test]
fn a_film_on_a_ledge_still_drains_over_the_edge() {
    let mut g = floor();
    for x in 30..70 {
        g.set((H - 20) * W + x, ROCK, 0);
    }
    for x in 30..70 {
        g.set((H - 21) * W + x, WATER, 0);
    }
    run(&mut g, 0, 2000);
    let on_ledge = (30..70).filter(|&x| g.mat[(H - 21) * W + x] == WATER).count();
    assert_eq!(on_ledge, 0, "{on_ledge} water cells still on the ledge");
}

/// Resting liquid wakes when the ground goes: the resting rule reads up to `reach` cells away, so a
/// change that far must wake the chunk (and across a chunk edge), or sleeping would be visible.
#[test]
fn a_resting_cell_wakes_when_a_gap_opens_within_reach_across_a_chunk_edge() {
    let run_it = |sleep: bool| {
        let mut g = floor();
        g.sleep_enabled = sleep;
        // Raised shelf x = 40..=63 and a lone drop on it at the chunk edge; the shelf continues into the
        // next chunk (x = 64..=70) then ends.
        for x in 40..=70 {
            g.set((H - 2) * W + x, ROCK, 0);
        }
        g.set((H - 3) * W + 63, WATER, 0);
        let t = run(&mut g, 0, 300);
        // Remove the shelf cell 5 cells to the right of the drop, in the other chunk.
        g.set((H - 2) * W + 68, EMPTY, 0);
        run(&mut g, t, 300);
        g.mat
    };
    assert!(run_it(true) == run_it(false), "sleeping changed the result (invariant 8)");
}
