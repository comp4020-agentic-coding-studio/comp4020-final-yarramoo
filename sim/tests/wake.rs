//! Brief W (D-176): a frozen chunk wakes when a running chunk changes a cell next to it, with no cap.
//! These tests use only the public grid, so they compile before and after the change.
use sim::grid::Grid;
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;

const W: usize = 1024;
const H: usize = 128;

/// A bedrock floor, a left wall, and the active region around x = 200 (chunks up to x < 512 are active).
fn world() -> Grid {
    let mut g = Grid::new(W, H);
    g.sleep_enabled = true;
    for x in 0..W {
        g.set((H - 1) * W + x, BEDROCK, 0);
    }
    for y in 0..H {
        g.set(y * W + 20, ROCK, 0);
    }
    g.set_active_around(&[(200, 64)]);
    g
}

fn run(g: &mut Grid, from: u32, to: u32) {
    for t in from..to {
        g.step_cells(5, t);
    }
}

/// The old assertion's intent: a frozen chunk that nothing reaches is not stepped and does not change.
#[test]
fn a_frozen_chunk_nothing_reaches_stays_frozen() {
    let mut g = world();
    // Water hanging in mid-air far inside the frozen region.
    for y in 60..70 {
        for x in 800..820 {
            g.set(y * W + x, WATER, 0);
        }
    }
    // Settle the active region.
    run(&mut g, 0, 50);
    let before = g.mat.clone();
    run(&mut g, 50, 300);
    assert_eq!(g.mat, before, "a frozen, unreached region changed");
    assert_eq!(g.ran_chunks, 0, "nothing should be running");
}

/// Fire spreading out of the region keeps burning in the frozen chunks it reaches.
#[test]
#[ignore = "red until Brief W commit 2 (shown failing before the change)"]
fn fire_spreading_out_of_the_region_keeps_burning() {
    let mut g = world();
    for x in 300..800 {
        g.set((H - 2) * W + x, WOOD, 0);
    }
    g.set((H - 3) * W + 320, FIRE, 0);
    run(&mut g, 0, 6000);
    let burnt_far = (700..800).filter(|&x| g.mat[(H - 2) * W + x] != WOOD).count();
    assert!(burnt_far >= 50, "fire did not carry on across the edge: {burnt_far} of 100 burnt");
}

/// A seed in a frozen chunk, reached by water from the active region, germinates and grows.
#[test]
#[ignore = "red until Brief W commit 2 (shown failing before the change)"]
fn a_seed_reached_by_water_across_the_edge_grows() {
    let mut g = world();
    for x in 21..W {
        g.set((H - 2) * W + x, DIRT, 0);
    }
    for y in 80..H - 2 {
        for x in 21..80 {
            g.set(y * W + x, WATER, 0);
        }
    }
    g.set((H - 3) * W + 530, SEED, 0);
    run(&mut g, 0, 12000);
    let plant = (0..H - 2).filter(|&y| matches!(g.mat[y * W + 530], STEM | FLOWER)).count();
    assert!(plant >= 3, "the seed never grew across the edge ({plant} plant cells)");
}

fn flow_script(sleep: bool) -> Vec<(u32, u64)> {
    // A game world, the player at the first entrance shaft, a carved cavity spanning the region's edge.
    let (x, y) = (500usize, 700usize);
    let mut s = Sim::new(9, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    let w = s.grid.w;
    let mut out = Vec::new();
    for t in 1..=900u32 {
        if t == 1 {
            s.push_input(&encode_join(1));
            s.push_input(&encode_pos(1, 0, (x as i32) * 16, (y as i32) * 16, 0));
        }
        if t == 100 {
            // Region edge is x = 788 (chunk edge 832): carve air across it and drop water on the left.
            for cy in 680..712 {
                for cx in 760..900 {
                    s.grid.set(cy * w + cx, EMPTY, 0);
                }
            }
            for cy in 690..700 {
                for cx in 770..790 {
                    s.grid.set(cy * w + cx, WATER, 0);
                }
            }
        }
        s.step();
        if t % 30 == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

/// Sleep on and off agree in a game world while a flow crosses the region's edge (woken chunks run the
/// same either way).
#[test]
fn sleep_on_and_off_agree_while_a_flow_crosses_the_region_edge() {
    assert_eq!(flow_script(true), flow_script(false));
}
