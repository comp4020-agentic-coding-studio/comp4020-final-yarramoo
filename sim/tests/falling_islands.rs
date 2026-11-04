//! Falling rock v0.5 (D-190): a small free island falls as itself, one cell per tick; large ones crumble.
use sim::grid::{is_structural, Grid};
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::tuning::{FALL_ISLAND_MAX, FALL_MAX_ISLANDS, ISLAND_MAX};

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

/// A floor at y=200..210 and a `bw` x `bh` block of `m` at (100, 100) hung from a one-cell column down to the floor.
fn hung(bw: usize, bh: usize, m: u8) -> Grid {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 210, ROCK);
    fill(&mut g, 100, 100, 100 + bw, 100 + bh, m);
    fill(&mut g, 100, 100 + bh, 101, 200, ROCK);
    g
}

fn cut(g: &mut Grid, y: usize) {
    g.set(y * N + 100, EMPTY, 0);
    g.crumble_islands();
}

fn settle(g: &mut Grid, ticks: usize) {
    for _ in 0..ticks {
        g.crumble_islands();
    }
}

#[test]
fn a_small_island_cut_free_falls_and_lands_intact() {
    let mut g = hung(6, 5, ROCK); // 30 cells
    cut(&mut g, 120); // frees the block and 15 column cells above the cut: 45 cells
    settle(&mut g, 200);
    // The column above the cut is 100..120 under the block (5 rows of block, then 105..120): the whole island
    // lands on the (still anchored) lower column stub, same cell count, no pebbles.
    assert_eq!(count(&g, 0, 0, N, N, PEBBLES), 0);
    // The 15 free column cells joined the block: 30 + 15 island cells, on top of the 78 stub cells (121..199).
    assert_eq!(count(&g, 0, 0, N, 199, ROCK), 30 + 15 + 78, "same cell count");
    // It rests on the stub: the lowest island cell is directly above the cut cell (y=119), the stub starts at 121.
    assert_eq!(g.mat[119 * N + 100], ROCK);
    assert_eq!(g.mat[100 * N + 100], EMPTY, "it moved down");
    assert!(g.falls.is_empty(), "landed, so no longer tracked");
}

#[test]
fn materials_are_kept_while_falling() {
    let mut g = hung(4, 4, GLASS);
    g.mat[101 * N + 101] = COAL;
    g.aux[101 * N + 101] = 0;
    cut(&mut g, 120);
    settle(&mut g, 200);
    assert_eq!(count(&g, 0, 0, N, 199, GLASS), 16 - 1);
    assert_eq!(count(&g, 0, 0, N, 199, COAL), 1);
}

#[test]
fn it_falls_one_cell_per_tick() {
    let mut g = hung(4, 4, ROCK);
    for y in 150..190 {
        g.set(y * N + 100, EMPTY, 0); // a 40-cell gap above the stub
    }
    g.crumble_islands();
    // The tick of the cut already moved it one cell.
    assert_eq!(g.mat[100 * N + 102], EMPTY, "top row left");
    assert_eq!(g.mat[104 * N + 102], ROCK);
    g.crumble_islands();
    assert_eq!(g.mat[101 * N + 102], EMPTY);
    assert_eq!(g.mat[105 * N + 102], ROCK);
    assert_eq!(g.falls.len(), 1);
}

#[test]
fn a_large_island_still_crumbles() {
    assert!(15 * 12 > FALL_ISLAND_MAX && 15 * 12 < ISLAND_MAX);
    let mut g = hung(15, 12, ROCK);
    cut(&mut g, 150);
    assert_eq!(count(&g, 100, 100, 115, 112, PEBBLES), 15 * 12);
    assert!(g.falls.is_empty());
}

#[test]
fn an_ice_island_still_melts() {
    let mut g = hung(4, 4, ICE);
    cut(&mut g, 150);
    assert_eq!(count(&g, 100, 100, 104, 104, WATER), 16);
    assert!(g.falls.is_empty());
}

#[test]
fn a_cut_tree_falls_as_wood_and_still_burns() {
    // A trunk 2 wide, 20 tall, standing on dirt; cut the trunk near its base.
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 210, DIRT);
    fill(&mut g, 100, 160, 102, 200, WOOD);
    fill(&mut g, 94, 170, 100, 171, WOOD); // a branch
    for x in 100..102 {
        g.set(190 * N + x, EMPTY, 0);
    }
    g.crumble_islands();
    let wood = count(&g, 0, 0, N, N, WOOD);
    settle(&mut g, 100);
    assert_eq!(count(&g, 0, 0, N, N, SAND), 0);
    assert_eq!(count(&g, 0, 0, N, N, PEBBLES), 0);
    assert_eq!(count(&g, 0, 0, N, N, WOOD), wood, "wood is conserved: it fell as logs");
    // The trunk now rests on the stump (cut at 190..191, stump 191..200), its top moved down by 1 cell
    // per tick until it stood on the stump... it was already standing on the gap: it falls one cell.
    assert!(g.mat[160 * N + 100] == EMPTY, "top of the trunk moved down");
    // Put out a fire beside it: it burns (Wood, not rubble).
    g.set(185 * N + 102, FIRE, 0);
    for t in 0..400 {
        g.step_cells(1, t);
    }
    assert!(count(&g, 0, 0, N, N, WOOD) < wood, "fallen logs burn");
}

#[test]
fn a_falling_island_displaces_liquid() {
    let mut g = hung(4, 4, ROCK);
    fill(&mut g, 90, 120, 120, 125, WATER); // a pool under the block
    // Clear the column under the block (y=104..120): the block alone is free, 16 cells.
    for y in 104..120 {
        g.set(y * N + 100, EMPTY, 0);
    }
    g.crumble_islands();
    let water = count(&g, 0, 0, N, N, WATER);
    let rock = count(&g, 0, 0, N, N, ROCK);
    settle(&mut g, 100);
    assert_eq!(count(&g, 0, 0, N, N, WATER), water, "no liquid is destroyed");
    assert_eq!(count(&g, 0, 0, N, N, ROCK), rock, "the island is intact");
    assert_eq!(count(&g, 100, 121, 104, 125, ROCK), 16, "and it moved down through the pool to rest on the rock");
}

#[test]
fn the_fall_stops_on_the_world_floor() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 100, 100, 104, 104, ROCK);
    fill(&mut g, 100, 104, 101, 110, ROCK);
    fill(&mut g, 100, 110, 101, 111, BEDROCK);
    g.set(107 * N + 100, EMPTY, 0);
    g.crumble_islands();
    settle(&mut g, 400);
    assert!(g.falls.is_empty());
}

#[test]
fn the_number_of_falling_islands_is_capped_and_work_is_bounded() {
    // Many separate 4x4 blocks, each hung by one cell from a ceiling of bedrock-free rock... use a floor each.
    let mut g = Grid::new(512, 512);
    let n = FALL_MAX_ISLANDS * 3;
    for k in 0..n {
        let (x0, y0) = ((k % 12) * 40 + 4, (k / 12) * 100 + 4);
        for y in y0..y0 + 4 {
            for x in x0..x0 + 4 {
                g.mat[y * 512 + x] = ROCK;
            }
        }
        for y in y0 + 4..y0 + 60 {
            g.mat[y * 512 + x0] = ROCK;
        }
        for x in x0.saturating_sub(2)..x0 + 3 {
            g.mat[(y0 + 60) * 512 + x] = ROCK; // a small anchor? no: free too; the bedrock below anchors it
        }
        for x in x0.saturating_sub(2)..x0 + 3 {
            g.mat[(y0 + 61) * 512 + x] = BEDROCK;
        }
        for y in y0 + 20..y0 + 40 {
            g.set(y * 512 + x0, EMPTY, 0); // a 20-cell gap to fall through
        }
    }
    g.crumble_islands();
    assert!(g.falls.len() <= FALL_MAX_ISLANDS);
    assert_eq!(g.falls.len(), FALL_MAX_ISLANDS, "the cap is reached");
    assert!(g.island_visits as usize <= sim::tuning::ISLAND_WORK_MAX);
    let before = g.island_fallen;
    g.crumble_islands();
    assert!((g.island_fallen - before) as usize <= FALL_MAX_ISLANDS * FALL_ISLAND_MAX, "cells moved per tick");
    assert!(g.falls.len() <= FALL_MAX_ISLANDS);
    // The rest crumbled rather than hanging: nothing structural is left free.
    assert!(g.island_crumbled as usize >= n - FALL_MAX_ISLANDS - 1, "crumbled {} falling {}", g.island_crumbled, g.falls.len());
}

fn sim_with_player(sleep: bool) -> Sim {
    let mut s = Sim::new(3, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    s.push_input(&encode_join(1));
    s.push_input(&encode_pos(1, 0, 780 * 16, 300 * 16, 0));
    s.step();
    s
}

/// Clear a cave in the rock around the player (x 765..795, rows y0..y1), so there is air to fall through.
fn cave(s: &mut Sim, y0: usize, y1: usize) {
    let w = s.grid.w;
    for y in y0..y1 {
        for x in 765..795 {
            s.grid.mat[y * w + x] = EMPTY;
        }
    }
    // Direct writes leave chunks "pristine", which a snapshot omits: mark them all as edited.
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
}

/// A 12 x 8 slab hung from the cave ceiling (cave must start at `y_top - 7`) by a column at x=780; the column
/// is cut two cells above the slab, freeing the slab and one column cell.
fn drop_slab(s: &mut Sim, y_top: usize) {
    let w = s.grid.w;
    for y in y_top..y_top + 8 {
        for x in 774..786 {
            s.grid.mat[y * w + x] = ROCK;
        }
    }
    for y in y_top - 7..y_top {
        s.grid.mat[y * w + 780] = ROCK;
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.grid.set((y_top - 2) * w + 780, EMPTY, 0);
}

#[test]
fn a_falling_island_stops_above_a_player_and_never_overwrites_the_hitbox() {
    let mut s = sim_with_player(true);
    let w = s.grid.w;
    let (x0, y0, x1, y1) = s.players[0].hitbox_cells();
    cave(&mut s, 243, 300);
    drop_slab(&mut s, 250);
    for _ in 0..200 {
        s.step();
        for y in y0..=y1 {
            for x in x0..=x1 {
                assert!(!is_structural(s.grid.mat[y as usize * w + x as usize]), "rock written over the player at {x},{y}");
            }
        }
    }
    // It reached the head and waits there (tracked, not crumbled), and the player is alive.
    assert!(!s.grid.falls.is_empty(), "the island waits above the player");
    assert_eq!(s.players[0].health, sim::tuning::HEALTH_MAX);
    assert_eq!(s.grid.mat[(y0 as usize - 1) * w + 780], ROCK, "it rests right on the head");
    // The player leaves: it resumes and lands on the ground.
    s.push_input(&encode_pos(1, 0, 767 * 16, 300 * 16, 0));
    for _ in 0..100 {
        s.step();
    }
    assert!(s.grid.falls.is_empty(), "landed once the player left");
    assert_eq!(s.grid.mat[299 * w + 780], ROCK);
}

fn run_hashes(sleep: bool, snap_at: Option<u32>) -> Vec<u64> {
    let mut s = sim_with_player(sleep);
    cave(&mut s, 243, 300);
    drop_slab(&mut s, 250);
    let mut out = Vec::new();
    for t in 0..120u32 {
        if Some(t) == snap_at {
            assert!(!s.grid.falls.is_empty(), "snapshot taken mid-fall");
            let b = sim::snapshot::write(&s);
            assert_eq!(b.len(), sim::snapshot::size(&s));
            s = sim::snapshot::restore(&b).unwrap();
            s.grid.sleep_enabled = sleep;
            assert_eq!(sim::snapshot::write(&s), b, "canonical re-encode");
        }
        s.step();
        out.push(s.state_hash());
    }
    out
}

#[test]
fn mid_fall_snapshot_restore_keeps_every_hash() {
    assert_eq!(run_hashes(true, None), run_hashes(true, Some(10)));
}

#[test]
fn d7_falling_island_sleep_is_invisible() {
    assert_eq!(run_hashes(true, None), run_hashes(false, None));
}

#[test]
fn a_falling_island_crosses_a_frozen_chunk_edge_without_sleep_changing_anything() {
    // The slab starts inside the player's active region and falls past it into frozen chunks (the player is far
    // above). Sleeping on and off must agree on every hash.
    fn run(sleep: bool) -> Vec<u64> {
        let mut s = Sim::new(3, 1).unwrap();
        s.grid.sleep_enabled = sleep;
        s.push_input(&encode_join(1));
        s.push_input(&encode_pos(1, 0, 780 * 16, 100 * 16, 0));
        s.step();
        let w = s.grid.w;
        let _ = w;
        // A shaft so the slab has a long way down, past the active rectangle's bottom edge (about y=260).
        cave(&mut s, 113, 420);
        drop_slab(&mut s, 120);
        let mut out = Vec::new();
        for _ in 0..330 {
            if out.len() == 200 {
                assert!(!s.grid.falls.is_empty(), "still falling beyond the active rectangle");
            }
            s.step();
            out.push(s.state_hash());
        }
        out
    }
    assert_eq!(run(true), run(false));
}

#[test]
fn restore_refuses_a_hostile_falling_list() {
    let s = sim_with_player(true);
    let mut b = sim::snapshot::write(&s);
    let n = b.len();
    // Claim 255 falling islands: refused, not a panic.
    let wlen = s.grid.chunk_count().div_ceil(8);
    b[n - wlen - 1] = 255;
    assert!(sim::snapshot::restore(&b).is_err());
}

/// World sweep (FUTURE.md): dig at a grid of sites in several Survival worlds. After a dig, rock may change
/// only where it was carved or where an independent flood says it is a free island (or one cell below such an
/// island, where a falling island lands). A free island must not stay hanging.
#[test]
fn world_sweep_rock_only_moves_when_really_cut_free() {
    use sim::config::RoomConfig;
    let mut checked = 0;
    for seed in 1..=3u64 {
        let mut s = Sim::new(seed, RoomConfig::survival()).unwrap();
        for i in 0..s.grid.mat.len() {
            if matches!(s.grid.mat[i], ACID | LAVA | GUNPOWDER) {
                s.grid.mat[i] = EMPTY;
            }
        }
        let (w, h) = (s.grid.w, s.grid.h);
        let base = s.grid.mat.clone();
        for sy in (40..h - 40).step_by(37) {
            for sx in (40..w - 40).step_by(41) {
                s.grid.mat.copy_from_slice(&base);
                s.grid.falls.clear();
                s.grid.island_removed.clear();
                // Dig a radius-3 disc, as a spell or a Dig would.
                let mut carved = Vec::new();
                for dy in -3i32..=3 {
                    for dx in -3i32..=3 {
                        if dx * dx + dy * dy > 9 {
                            continue;
                        }
                        let i = (sy as i32 + dy) as usize * w + (sx as i32 + dx) as usize;
                        if is_structural(s.grid.mat[i]) {
                            s.grid.set(i, EMPTY, 0);
                            carved.push(i);
                        }
                    }
                }
                if carved.is_empty() {
                    continue;
                }
                let after_carve = s.grid.mat.clone();
                s.grid.crumble_islands();
                let free = oracle_free(&after_carve, w, h);
                let mut allowed = vec![false; w * h];
                for &c in &free {
                    allowed[c] = true;
                    if c + w < w * h {
                        allowed[c + w] = true;
                    }
                }
                for i in 0..w * h {
                    if after_carve[i] != s.grid.mat[i] {
                        assert!(allowed[i], "seed {seed} dig ({sx},{sy}): cell ({},{}) {} -> {} changed but was not cut free (w {w})", i % w, i / w, after_carve[i], s.grid.mat[i]);
                    }
                }
                if free.is_empty() {
                    assert!(s.grid.falls.is_empty(), "seed {seed} dig ({sx},{sy}): nothing free but something falls");
                }
                checked += 1;
            }
        }
    }
    assert!(checked > 100, "only {checked} sites dug");
}

/// Independent reference: structural cells in 4-connected components of at most ISLAND_MAX cells that touch no
/// Bedrock and no world edge. (Components are found by a plain flood over the whole map.)
fn oracle_free(mat: &[u8], w: usize, h: usize) -> Vec<usize> {
    let mut seen = vec![false; w * h];
    let mut free = Vec::new();
    for s in 0..w * h {
        if seen[s] || !is_structural(mat[s]) {
            continue;
        }
        let mut comp = vec![s];
        seen[s] = true;
        let mut k = 0;
        let mut anchored = false;
        while k < comp.len() {
            let c = comp[k];
            k += 1;
            let (x, y) = (c % w, c / w);
            if x == 0 || y == 0 || x + 1 == w || y + 1 == h {
                anchored = true;
                continue;
            }
            for j in [c - w, c - 1, c + 1, c + w] {
                if mat[j] == BEDROCK {
                    anchored = true;
                } else if is_structural(mat[j]) && !seen[j] {
                    seen[j] = true;
                    comp.push(j);
                }
            }
        }
        if !anchored && comp.len() < ISLAND_MAX {
            free.extend(comp);
        }
    }
    free
}

// ---- review N4 fixes (F1, F2, F6) ----

#[test]
fn two_falling_slabs_that_merge_past_the_cap_crumble_instead_of_hanging() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 210, ROCK);
    fill(&mut g, 100, 100, 110, 107, ROCK); // A: 10 x 7 = 70
    fill(&mut g, 105, 107, 106, 200, ROCK);
    fill(&mut g, 110, 80, 120, 87, ROCK); // B: 70, higher, beside A's column of rows
    fill(&mut g, 115, 87, 116, 200, ROCK);
    g.fall_blockers.push((100, 107, 109, 107)); // A waits (as above a player)
    for y in 107..112 {
        g.set(y * N + 105, EMPTY, 0);
    }
    for y in 87..150 {
        g.set(y * N + 115, EMPTY, 0);
    }
    g.crumble_islands();
    assert_eq!(g.falls.len(), 2);
    settle(&mut g, 60);
    // B has met A: 140 free cells, over the cap, so they crumble like any big free island.
    assert!(g.falls.is_empty());
    assert_eq!(count(&g, 0, 0, N, 112, ROCK), 0, "no free rock may hang in mid-air");
    assert_eq!(count(&g, 0, 0, N, N, PEBBLES), 140 + 0, "crumbled to pebbles");
}

#[test]
fn an_island_resting_on_sand_is_not_left_floating_when_the_sand_goes() {
    let mut g = hung(4, 4, ROCK);
    fill(&mut g, 90, 190, 110, 200, SAND); // a sand pile on the floor
    for y in 104..150 {
        g.set(y * N + 100, EMPTY, 0);
    }
    g.crumble_islands();
    settle(&mut g, 200);
    // Whatever the sand does, the block must end on the floor (y 196..200 region), not hang above it.
    let lowest = (0..N).rev().find(|&y| (96..108).any(|x| g.mat[y * N + x] == ROCK && y < 200)).unwrap();
    assert!(lowest >= 198, "block hangs at row {lowest}");
}

#[test]
fn restore_refuses_a_falling_seed_that_is_out_of_range_or_not_rock() {
    let s = sim_with_player(true);
    let wlen = s.grid.chunk_count().div_ceil(8);
    let base = sim::snapshot::write(&s);
    let n = base.len();
    for seed in [(s.grid.w * s.grid.h) as u32, 0u32, 123_456u32] {
        let mut b = base[..n - wlen - 1].to_vec();
        b.push(1);
        b.extend_from_slice(&seed.to_le_bytes());
        b.extend_from_slice(&base[n - wlen..]);
        assert!(sim::snapshot::restore(&b).is_err(), "seed {seed} accepted");
    }
}
