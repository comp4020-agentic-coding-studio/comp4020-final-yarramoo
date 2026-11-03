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

/// The active region (plan 6.5), as amended by Brief W (D-176): chunks outside the 576 x 320 rectangle
/// around the player are frozen, but a frozen chunk wakes when a running chunk changes a cell next to it.
///
/// DELIBERATELY FLIPPED (Brief W). The old test, `water_front_freezes_on_the_active_region_edge_and_resumes_
/// when_the_player_moves`, asserted that water released inside the region ran to its edge and STOPPED there,
/// a steep face on a chunk edge (front in 500..=520), and only advanced once the player moved. Playtest note 3
/// showed that as liquid hanging in mid-air. The intent (a frozen chunk is not stepped by being near nothing)
/// survives in `tests/wake.rs::a_frozen_chunk_nothing_reaches_stays_frozen`. Here the front must cross the
/// edge with the player standing still, and nothing may hang over air once it settles.
#[test]
fn water_front_crosses_the_active_region_edge_and_settles() {
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
    for y in 40..h - 1 {
        for x in 21..120 {
            g.set(y * w + x, WATER, 0);
        }
    }
    for t in 0..8000 {
        g.step_cells(5, t);
    }
    let right = |g: &Grid| (0..w).rev().find(|&x| (0..h).any(|y| g.mat[y * w + x] == WATER)).unwrap();
    assert!(right(&g) > 512 + 64, "front stopped at the active region edge: {}", right(&g));
    // Settled: no water cell has open air straight below it, and none has a free side with air beneath.
    for y in 0..h - 1 {
        for x in 21..w - 1 {
            if g.mat[y * w + x] == WATER {
                assert_ne!(g.mat[(y + 1) * w + x], EMPTY, "water hangs over air at {x},{y}");
            }
        }
    }
}
