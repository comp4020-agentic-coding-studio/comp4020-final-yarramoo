//! Playtest note 3 (3 Nov): liquid fronts ending in vertical walls on chunk edges. Native reproductions
//! on `Grid` directly, with sleeping on and off, and with the active rectangle moving.
use sim::grid::Grid;
use sim::materials::*;

const W: usize = 320;
const H: usize = 128;

/// A water body in a rock box, held by a rock wall at x = 150 that straddles nothing but whose water
/// crosses the x = 128 chunk edge. The wall is then removed and the water must flow right.
fn setup(sleep: bool, mat: u8) -> Grid {
    let mut g = Grid::new(W, H);
    g.set_all_active();
    g.sleep_enabled = sleep;
    for x in 0..W {
        g.set((H - 1) * W + x, BEDROCK, 0);
    }
    for y in 0..H {
        g.set(y * W + 20, ROCK, 0);
        g.set(y * W + 150, ROCK, 0);
    }
    for y in 60..H - 1 {
        for x in 21..150 {
            g.set(y * W + x, mat, 0);
        }
    }
    for t in 0..3000 {
        g.step_cells(5, t);
    }
    g
}

fn remove_wall(g: &mut Grid) {
    for y in 0..H - 1 {
        g.set(y * W + 150, EMPTY, 0);
    }
}

/// Rightmost and leftmost x holding `m` in the bottom row above the floor.
fn extent(g: &Grid, m: u8) -> (usize, usize) {
    let row = (H - 2) * W;
    let xs: Vec<usize> = (0..W).filter(|&x| g.mat[row + x] == m).collect();
    (*xs.first().unwrap(), *xs.last().unwrap())
}

fn run_released(sleep: bool, mat: u8, ticks: u32) -> Grid {
    let mut g = setup(sleep, mat);
    remove_wall(&mut g);
    for t in 3000..3000 + ticks {
        g.step_cells(5, t);
    }
    g
}

#[test]
fn water_released_across_chunk_edges_is_identical_with_sleeping_on_and_off() {
    let (on, off) = (run_released(true, WATER, 1500), run_released(false, WATER, 1500));
    assert_eq!(on.mat, off.mat, "sleeping changed the result (invariant 8)");
}

#[test]
fn lava_released_across_chunk_edges_is_identical_with_sleeping_on_and_off() {
    let (on, off) = (run_released(true, LAVA, 3000), run_released(false, LAVA, 3000));
    assert_eq!(on.mat, off.mat, "sleeping changed the result (invariant 8)");
}

#[test]
fn released_water_front_does_not_stop_on_a_chunk_edge() {
    for sleep in [true, false] {
        let g = run_released(sleep, WATER, 1500);
        let (l, r) = extent(&g, WATER);
        eprintln!("sleep {sleep}: water spans {l}..={r}");
        // 129 columns of 68 cells' depth spread over ~299 columns leaves a film several cells deep
        // everywhere; the front must reach the right wall region, not stall at a multiple of 64.
        assert!(r >= W - 3, "sleep {sleep}: front stalled at x = {r} (chunk edge {})", r / 64 * 64);
    }
}

/// The active region (plan 6.5): chunks outside the 576 x 320 rectangle around the player are frozen.
/// Water released inside it runs to the region's edge and stops there, a vertical face on a chunk edge
/// (that is the design, not a bug). Moving the player shifts the region and the front moves on.
#[test]
fn water_front_freezes_on_the_active_region_edge_and_resumes_when_the_player_moves() {
    let (w, h) = (1024usize, 128usize);
    let mut g = Grid::new(w, h);
    g.sleep_enabled = true;
    for x in 0..w {
        g.set((h - 1) * w + x, BEDROCK, 0);
    }
    g.set_active_around(&[(200, 64)]);
    for y in 0..h {
        g.set(y * w + 20, ROCK, 0);
    }
    // A deep block of water.
    for y in 40..h - 1 {
        for x in 21..120 {
            g.set(y * w + x, WATER, 0);
        }
    }
    for t in 0..2000 {
        g.step_cells(5, t);
    }
    let right = |g: &Grid| (0..w).rev().find(|&x| (0..h).any(|y| g.mat[y * w + x] == WATER)).unwrap();
    let r0 = right(&g);
    // Rectangle: x in [200-288, 200+288) = up to 488, chunks intersecting reach x < 512.
    assert!((500..=520).contains(&r0), "front at {r0}, expected frozen at the chunk edge 512 (a slide may cross it a few cells)");
    // The face is steep: the front column is several cells deep.
    let depth = (0..h).filter(|&y| g.mat[y * w + r0] == WATER).count();
    eprintln!("front x = {r0}, depth at front = {depth}");
    g.set_active_around(&[(600, 64)]);
    for t in 2000..4000 {
        g.step_cells(5, t);
    }
    assert!(right(&g) > 512 + 64, "front did not advance after the region moved: {}", right(&g));
}
