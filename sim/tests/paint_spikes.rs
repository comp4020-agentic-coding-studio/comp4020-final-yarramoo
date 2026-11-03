//! Playtest note 5/14: sand spikes below paint strokes over dirt. Native repro.
use sim::config::RoomConfig;
use sim::materials::*;
use sim::sim::Sim;

/// Sand cells farther than `r` from every stroke segment are "outside the brush".
fn near(strokes: &[(i32, i32, i32, i32)], r: i32, x: i32, y: i32) -> bool {
    strokes.iter().any(|&(x0, y0, x1, y1)| {
        let (dx, dy) = (x1 - x0, y1 - y0);
        let l2 = (dx * dx + dy * dy).max(1);
        let t = (((x - x0) * dx + (y - y0) * dy) * 1000 / l2).clamp(0, 1000);
        let (px, py) = (x0 + dx * t / 1000, y0 + dy * t / 1000);
        (x - px) * (x - px) + (y - py) * (y - py) <= (r + 2) * (r + 2)
    })
}

fn disc(g: &mut sim::grid::Grid, cx: i32, cy: i32, r: i32) {
    for y in cy - r..=cy + r { for x in cx - r..=cx + r {
        if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r && g.mat[y as usize * g.w + x as usize] != BEDROCK {
            g.set(y as usize * g.w + x as usize, SAND, 0);
        }
    } }
}

/// Stamp 40 short Sand strokes (radius 3, as `Sim::paint` does: a disc per step along the line) through Dirt
/// over Rock, settle, and list Sand cells farther than the brush radius (+2) from every stroke. With `crumble`
/// false the removed-cell queue is cleared instead of flooded, which switches falling rock off.
/// The world comes from `Sim::new` (the Creative generator); the dynamics are driven on the grid directly.
fn outside_sand(seed: u64, crumble: bool) -> (usize, u32, Vec<(i32, i32)>) {
    let mut s = Sim::new(seed, RoomConfig { avatars: 0, ..RoomConfig::creative() }).unwrap();
    let w = s.grid.w;
    let g = &mut s.grid;
    g.set_all_active();
    let by = (0..g.h).find(|&y| g.mat[y * w + 200] == ROCK).unwrap() as i32;
    let mut strokes = vec![];
    let mut rs = seed * 7919;
    let mut rnd = |m: i32| { rs = rs.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((rs >> 33) as i32).rem_euclid(m) };
    let (mut px, mut py) = (150, by - 60);
    let mut tick = 0u32;
    let step = |g: &mut sim::grid::Grid, tick: &mut u32| {
        g.step_cells(seed, *tick);
        if crumble { g.crumble_islands(); } else { g.island_removed.clear(); }
        *tick += 1;
    };
    for _ in 0..40 {
        let (nx, ny) = ((px + rnd(41) - 20).clamp(60, 400), (py + rnd(21) - 10).clamp(by - 80, by - 8));
        strokes.push((px, py, nx, ny));
        let n = (nx - px).abs().max((ny - py).abs()).max(1);
        for k in 0..=n { disc(g, px + (nx - px) * k / n, py + (ny - py) * k / n, 3); }
        step(g, &mut tick);
        (px, py) = (nx, ny);
    }
    for _ in 0..400 { step(g, &mut tick); }
    let mut bad = vec![];
    for y in 0..g.h as i32 { for x in 0..w as i32 {
        if g.mat[y as usize * w + x as usize] == SAND && !near(&strokes, 3, x, y) { bad.push((x, y)); }
    } }
    (bad.len(), g.island_crumbled, bad)
}

/// Note 5, seed 1: before the anchor fix this left a 2-cell sand spike at (213,62..63), outside every stroke, in
/// the solid dirt under the brush (the same bug as note 14). Seeds 2 and 3 do crumble real enclosed dirt, which
/// is the separate "instant fill" (fixed by commit 2), so they are not asserted here.
#[test]
fn sand_strokes_over_dirt_leave_no_spikes() {
    let (n_on, _, bad) = outside_sand(1, true);
    let (n_off, _, _) = outside_sand(1, false);
    assert_eq!(n_off, 0, "with falling rock off no sand appears outside the brush");
    assert_eq!(n_on, 0, "sand outside the brush: {bad:?}");
}

/// Note 14: one Dig at the left edge of the seed-1 Survival world (dirt over a thick rock layer, bedrock to the
/// left) must not turn any Rock into Sand. Before the fix, the island flood did not treat a neighbour that an
/// earlier flood in the same pass had visited as part of that (anchored) island, so a thin strip of rock between
/// two visited regions looked unanchored and crumbled: a 4-wide column of Sand 35 deep through the rock.
#[test]
fn one_dig_does_not_crumble_the_rock_layer() {
    let mut s = Sim::new(1, RoomConfig::survival()).unwrap();
    let w = s.grid.w;
    s.grid.set_all_active();
    let before = s.grid.mat.clone();
    s.grid.dig(20, 135, 26, 141, 5);
    s.grid.crumble_islands();
    let rock_to_sand = (0..before.len()).filter(|&i| before[i] == ROCK && s.grid.mat[i] == SAND).count();
    let dug = (0..before.len()).filter(|&i| before[i] != EMPTY && s.grid.mat[i] == EMPTY).count();
    assert!(dug > 20, "the dig removed {dug} cells");
    let at = |x: usize, y: usize| (before[y * w + x], s.grid.mat[y * w + x]);
    assert_eq!(rock_to_sand, 0, "rock turned to sand, e.g. at (26,170): {:?}", at(26, 170));
}
